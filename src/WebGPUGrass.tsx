import { useFrame, useThree } from "@react-three/fiber";
import { useControls } from "leva";
import { useRef, useMemo, useEffect } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  instancedArray,
  instanceIndex,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  fract,
  floor,
  dot,
  mix,
  sin,
  cos,
  abs,
  clamp,
  pow,
  step,
  smoothstep,
  length,
  max,
  normalize,
  uv,
  positionGeometry,
  transformNormalToView,
  sign,
  varying,
} from "three/tsl";

// Hash functions for pseudo-random numbers
const hash11 = Fn(([pIn]: [THREE.Node<"float">]) => {
  const p = fract(pIn.mul(0.1031)).toVar();
  p.mulAssign(p.add(33.33));
  p.mulAssign(p.add(p));
  return fract(p);
});

const hash12 = Fn(([p]: [THREE.Node<"vec2">]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

const hash22 = Fn(([p]: [THREE.Node<"vec2">]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});

// Simple value noise
const noise = Fn(([p]: [THREE.Node<"vec2">]) => {
  const i = floor(p);
  const f = fract(p);
  const a = hash12(i);
  const b = hash12(i.add(vec2(1.0, 0.0)));
  const c = hash12(i.add(vec2(0.0, 1.0)));
  const d = hash12(i.add(vec2(1.0, 1.0)));
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
  return mix(a, b, u.x)
    .add(c.sub(a).mul(u.y).mul(u.x.oneMinus()))
    .add(d.sub(b).mul(u.x).mul(u.y));
});

function createBladeGeometry(bladeCount: number) {
  const width = 0.1;
  const height = 0.6;

  const yPositions = [0.0, 0.6, 0.8, 1.0];

  const vertices = [];
  const uvs = [];
  const indices = [];

  // Create vertices - all levels except tip have 2 vertices
  for (let y = 0; y < yPositions.length - 1; y++) {
    const v = yPositions[y];
    const taper = 1.0 - v * v * 0.9;

    vertices.push(-width * 0.5 * taper, v * height, 0);
    vertices.push(width * 0.5 * taper, v * height, 0);

    uvs.push(0, v);
    uvs.push(1, v);
  }

  // Add single tip vertex
  const tipV = yPositions[yPositions.length - 1];
  vertices.push(0, tipV * height, 0);
  uvs.push(0.5, tipV);

  // Create indices - quads for body, triangle for tip
  for (let y = 0; y < yPositions.length - 2; y++) {
    const base = y * 2;
    indices.push(base, base + 1, base + 2);
    indices.push(base + 1, base + 3, base + 2);
  }

  const lastQuadBase = (yPositions.length - 2) * 2;
  indices.push(lastQuadBase, lastQuadBase + 1, lastQuadBase + 2);

  // Instanced geometry without per-instance attributes: per-blade data lives
  // in storage buffers indexed by instanceIndex, so no instanceMatrix needed
  const geom = new THREE.InstancedBufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  geom.instanceCount = bladeCount;

  return geom;
}

function createGrass(bladeCount: number) {
  const uniforms = {
    time: uniform(0),
    fieldSize: uniform(50),
    windSpeed: uniform(1),
    grassHeight: uniform(1.3),
    cameraPos: uniform(new THREE.Vector3()),
    spherePosition: uniform(new THREE.Vector3(0, 1, 0)),
    oldestTrailPosition: uniform(new THREE.Vector3(0, 1, 0)),
  };

  // Static per-blade data, written by the init pass (compute-only)
  const bladeBase = instancedArray(bladeCount, "vec4"); // posX, posZ, cosRot, sinRot
  const bladeShape = instancedArray(bladeCount, "vec4"); // height, width, restBend.xz
  const bladeParams = instancedArray(bladeCount, "vec2"); // stiffness, colorVar

  // Per-frame per-blade data, packed for the vertex shader (3 vec4 per vertex)
  const bladeXform = instancedArray(bladeCount, "vec4"); // posX, posZ, scaled blade x axis
  const bladeBend = instancedArray(bladeCount, "vec4"); // linear bend.xz, cubic droop, signed height
  const bladeLook = instancedArray(bladeCount, "vec4"); // restBend.xz, colorVar, shade

  const init = Fn(() => {
    const idx = float(instanceIndex);

    const randPos = hash22(vec2(idx.mul(0.0013), idx.mul(0.0017)));
    const pos = randPos.sub(0.5).mul(uniforms.fieldSize);

    const sizeVars = hash22(vec2(idx.mul(0.0019), idx.mul(0.0023)));
    const heightVar = uniforms.grassHeight.add(sizeVars.x.mul(0.8));
    const widthVar = sizeVars.y.mul(0.6).add(0.7);
    const stiffness = hash11(idx.mul(0.0071)).mul(0.8).add(0.5);
    const randomRotation = hash11(idx.mul(0.0037)).mul(6.28318);

    // Random initial bend - gives blades natural resting position.
    // Pre-scaled by height; vertex applies it with a uv.y^2 curve
    const bendVars = hash22(vec2(idx.mul(0.0041), idx.mul(0.0047)));
    const bendAngle = bendVars.x.mul(6.28318);
    const restBend = vec2(cos(bendAngle), sin(bendAngle))
      .mul(bendVars.y.mul(0.25))
      .mul(heightVar);

    const colorVar = hash11(idx.mul(0.0031));

    bladeBase
      .element(instanceIndex)
      .assign(vec4(pos, cos(randomRotation), sin(randomRotation)));
    bladeShape.element(instanceIndex).assign(vec4(heightVar, widthVar, restBend));
    bladeParams.element(instanceIndex).assign(vec2(stiffness, colorVar));
  })().compute(bladeCount);

  // Everything that only depends on the blade (not the vertex) is computed
  // once per blade here, instead of once per vertex in the vertex shader
  const update = Fn(() => {
    const base = bladeBase.element(instanceIndex);
    const grassPos = base.xy;
    const cosRot = base.z;
    const sinRot = base.w;
    const shape = bladeShape.element(instanceIndex);
    const heightVar = shape.x;
    const widthVar = shape.y;
    const restBend = shape.zw;
    const params = bladeParams.element(instanceIndex);
    const stiffness = params.x;
    const colorVar = params.y;

    // View-space thickening
    const viewDirXZ = normalize(uniforms.cameraPos.xz.sub(grassPos));
    const grassFaceNormal = vec2(sinRot.negate(), cosRot);
    const viewDotNormal = clamp(abs(dot(grassFaceNormal, viewDirXZ)), 0.0, 1.0);
    const thicken = pow(viewDotNormal.oneMinus(), 2.0);

    // Wind system
    const windSpeed = uniforms.windSpeed;
    const windTime = uniforms.time.mul(windSpeed);
    const detailCoord = grassPos
      .mul(0.1)
      .add(vec2(windTime.mul(-0.4), windTime.mul(-0.2)));
    const windDetail = noise(detailCoord).mul(0.4);
    const gustCoord = grassPos
      .mul(0.03)
      .add(vec2(windTime.mul(-0.6), windTime.mul(-0.5)));
    const gustBase = noise(gustCoord).mul(0.4);
    const totalWind = windDetail
      .add(gustBase)
      .mul(windSpeed)
      .div(stiffness)
      .sub(windSpeed.mul(0.5))
      .toVar();

    // Line-based bending for sphere trail
    const influenceRadius = 1.45;
    const lineStart = uniforms.oldestTrailPosition.xz;
    const lineEnd = uniforms.spherePosition.xz;
    const lineVector = lineEnd.sub(lineStart);
    const safeLineLength = max(length(lineVector), 0.001);
    const lineDirection = lineVector.div(safeLineLength);

    const toGrass = grassPos.sub(lineStart);
    const projectionLength = clamp(dot(toGrass, lineDirection), 0.0, safeLineLength);
    const closestPointOnLine = lineStart.add(lineDirection.mul(projectionLength));
    const toPoint = grassPos.sub(closestPointOnLine);
    const distanceToLine = length(toPoint);

    const positionAlongLine = projectionLength.div(safeLineLength);
    const bendStrength = smoothstep(
      0.0,
      1.0,
      float(1.0).sub(distanceToLine.div(influenceRadius))
    )
      .mul(smoothstep(0.0, 1.0, positionAlongLine))
      .mul(1.3)
      .toVar();
    const awayDirection = toPoint.div(max(distanceToLine, 0.001));

    // Wind and sphere both bend linearly with uv.y in xz and droop with uv.y^3
    const linearBend = vec2(totalWind, totalWind.mul(0.3))
      .add(awayDirection.mul(bendStrength))
      .toVar();
    const droop = totalWind
      .mul(totalWind)
      .mul(0.1)
      .add(bendStrength.mul(bendStrength).mul(0.3))
      .toVar();

    // Single-sided rendering: if the camera sees the back of the blade, mirror
    // it across its local x. The blade is symmetric so the shape is identical,
    // but the winding flips so the front face points at the camera.
    // Facing is tested against the base-to-tip vector, including all bends
    // (0.6 is the unscaled geometry height)
    const tip = vec3(
      restBend.x.add(linearBend.x),
      heightVar.mul(0.6).sub(dot(restBend, restBend).mul(0.2)).sub(droop),
      restBend.y.add(linearBend.y)
    );
    const faceNormal = vec3(
      sinRot.mul(tip.y).negate(),
      sinRot.mul(tip.x).sub(cosRot.mul(tip.z)),
      cosRot.mul(tip.y)
    );
    const toCamera = uniforms.cameraPos.sub(
      vec3(grassPos.x, 0.0, grassPos.y).add(tip.mul(0.5))
    );
    const flip = step(0.0, dot(faceNormal, toCamera)).mul(2.0).sub(1.0);

    const xAxis = vec2(cosRot, sinRot).mul(widthVar.add(thicken.mul(4.0))).mul(flip);

    // Shadow effect from sphere
    const distanceToSphere = length(grassPos.sub(uniforms.spherePosition.xz));
    const shadowStrength = smoothstep(0.0, 2.0, distanceToSphere).oneMinus().mul(0.8);

    bladeXform.element(instanceIndex).assign(vec4(grassPos, xAxis));
    bladeBend
      .element(instanceIndex)
      .assign(vec4(linearBend, droop, heightVar.mul(flip)));
    bladeLook
      .element(instanceIndex)
      .assign(vec4(restBend, colorVar, shadowStrength.oneMinus()));
  })().compute(bladeCount);

  const xform = bladeXform.toAttribute();
  const bend = bladeBend.toAttribute();
  const look = bladeLook.toAttribute();

  const uvY = uv().y;

  const position = Fn(() => {
    const heightVar = abs(bend.w);
    const restBend = look.xy;

    const uvY2 = uvY.mul(uvY);
    const uvY3 = uvY2.mul(uvY);

    // Initial resting bend (uv.y^2 curve) plus wind + sphere trail (linear)
    const offsetXZ = restBend.mul(uvY2).add(bend.xy.mul(uvY));

    // Length compensation for all bends
    const droop = dot(restBend, restBend)
      .mul(0.2)
      .mul(uvY2)
      .add(bend.z)
      .mul(uvY3);

    // Blade geometry lies in the local xy plane, so rotate + scale is one mul
    const xz = xform.xy.add(xform.zw.mul(positionGeometry.x)).add(offsetXZ);
    return vec3(xz.x, positionGeometry.y.mul(heightVar).sub(droop), xz.y);
  })();

  // Lighting modifier with yellow tint at tips - all in vertex
  const color = Fn(() => {
    const colorVar = look.z;
    const shade = look.w;
    const tint = vec3(0.12, 0.62, 0.12).add(
      vec3(0.1, 0.3, 0.05).mul(colorVar.sub(0.5).mul(2.0))
    );

    const linearModifier = uvY.add(0.1);
    const tipFactor = uvY.sub(0.66).mul(3.0);
    const tipModifier = tipFactor.mul(tipFactor).mul(2.5).add(0.8);
    const lightIntensity = mix(linearModifier, tipModifier, step(0.75, uvY));
    const lightColor = mix(
      vec3(1.0),
      vec3(1.0, 0.9, 0.6),
      smoothstep(1.0, 1.5, lightIntensity)
    );
    return tint.mul(shade).mul(lightColor).mul(lightIntensity);
  })();

  // Rounded normal for cylindrical appearance, rotated with the blade.
  // axis is the (possibly mirrored) blade x direction; for mirrored blades the
  // roundness flips too so shading matches what the back face looked like
  const axis = normalize(xform.zw);
  const flip = sign(bend.w);
  const roundness = uv().x.sub(0.5).mul(2.0).mul(0.75).mul(flip);
  const normalXZ = axis.mul(roundness).add(vec2(axis.y.negate(), axis.x));
  const localNormal = normalize(vec3(normalXZ.x, 0.0, normalXZ.y));
  const normal = varying(transformNormalToView(localNormal)).normalize();

  const material = new THREE.MeshLambertNodeMaterial();
  material.positionNode = position;
  material.colorNode = varying(color);
  material.normalNode = normal;

  const buffers = [bladeBase, bladeShape, bladeParams, bladeXform, bladeBend, bladeLook];

  return {
    uniforms,
    init,
    update,
    material,
    dispose: () => {
      material.dispose();
      for (const buffer of buffers) buffer.value.dispose?.();
    },
  };
}

export default function WebGPUGrass({
  spherePosition,
}: {
  spherePosition?: THREE.Vector3;
}) {
  const renderer = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const oldestTrailPosition = useRef(new THREE.Vector3(0, 1, 0));
  const needsInit = useRef(true);

  const {
    "Blade Count": bladeCount,
    "Field Size": fieldSize,
    "Blade Height": bladeHeight,
    "Wind Speed": windSpeedLeva,
  } = useControls("🌿 Grass Field", {
    "Blade Count": { value: 150000, min: 1000, max: 500000, step: 1000 },
    "Blade Height": { value: 1.3, min: 0.7, max: 4.0, step: 0.1 },
    "Field Size": { value: 50, min: 10, max: 200, step: 5 },
    "Wind Speed": { value: 1.3, min: 0.0, max: 5.0, step: 0.1 },
  });

  const geometry = useMemo(() => createBladeGeometry(bladeCount), [bladeCount]);
  const grass = useMemo(() => createGrass(bladeCount), [bladeCount]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => grass.dispose(), [grass]);

  // Static blade data only changes with these, so re-run the init pass
  useEffect(() => {
    grass.uniforms.fieldSize.value = fieldSize;
    grass.uniforms.grassHeight.value = bladeHeight;
    needsInit.current = true;
  }, [grass, fieldSize, bladeHeight]);

  useEffect(() => {
    grass.uniforms.windSpeed.value = windSpeedLeva;
  }, [grass, windSpeedLeva]);

  useFrame((state, delta) => {
    const { uniforms } = grass;
    uniforms.time.value = state.clock.elapsedTime;
    uniforms.cameraPos.value.copy(state.camera.position);

    if (spherePosition) {
      oldestTrailPosition.current.lerp(spherePosition, delta * 0.6);
      uniforms.spherePosition.value.copy(spherePosition);
      uniforms.oldestTrailPosition.value.copy(oldestTrailPosition.current);
    }

    if (needsInit.current) {
      renderer.compute(grass.init);
      needsInit.current = false;
    }
    renderer.compute(grass.update);
  });

  return (
    <mesh
      geometry={geometry}
      material={grass.material}
      frustumCulled={false}
    />
  );
}
