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
  faceDirection,
  varying,
  select,
  int,
  positionWorld,
  cameraPosition,
  saturate,
} from "three/tsl";

// Trail map resolution (cells per side) and the ball's stamp radius
const TRAIL_RES = 512;
const TRAIL_RADIUS = 1.45;

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
    previousSpherePosition: uniform(new THREE.Vector3(0, 1, 0)),
    trailFadeStep: uniform(0),
    tipTint: uniform(new THREE.Vector3(1.0, 0.9, 0.6)),
    sunDirection: uniform(new THREE.Vector3(0, 1, 0)),
    translucency: uniform(0),
    specular: uniform(new THREE.Color(0x000000)),
    ridge: uniform(0.6),
  };

  // Trail map over the field: each cell holds the xz push vector (bend
  // direction scaled by strength) that blades rooted there get, plus a life
  // that counts down from 1 so the blades recover with an ease-out
  const trailMap = instancedArray(TRAIL_RES * TRAIL_RES, "vec4");

  // Springs up fast, then settles gently into rest over a fixed time
  const recovery = (life: THREE.Node<"float">) => life.mul(life);

  const clearTrail = Fn(() => {
    trailMap.element(instanceIndex).assign(vec4(0.0));
  })().compute(TRAIL_RES * TRAIL_RES);

  // Fade the map back towards rest, then stamp the ball's footprint
  const stampTrail = Fn(() => {
    const cell = vec2(
      float(instanceIndex.mod(TRAIL_RES)),
      float(instanceIndex.div(TRAIL_RES))
    );
    const cellPos = cell.add(0.5).div(TRAIL_RES).sub(0.5).mul(uniforms.fieldSize);
    const trail = trailMap.element(instanceIndex);
    const life = max(trail.z.sub(uniforms.trailFadeStep), 0.0);
    const current = trail.xy.mul(recovery(life)).toVar();

    // Capsule from last frame's ball position to this frame's, so fast
    // movement leaves a continuous trail
    const segStart = uniforms.previousSpherePosition.xz;
    const segment = uniforms.spherePosition.xz.sub(segStart);
    const t = clamp(
      dot(cellPos.sub(segStart), segment).div(max(dot(segment, segment), 1e-6)),
      0.0,
      1.0
    );
    const toCell = cellPos.sub(segStart.add(segment.mul(t)));
    const distance = length(toCell);
    const strength = smoothstep(
      0.0,
      1.0,
      float(1.0).sub(distance.div(TRAIL_RADIUS))
    ).mul(1.3);
    const stamp = toCell.div(max(distance, 0.001)).mul(strength).toVar();

    // Strongest push wins, so the stamp never weakens an existing trail
    trail.assign(
      select(
        dot(stamp, stamp).greaterThan(dot(current, current)),
        vec4(stamp, 1.0, 0.0),
        vec4(trail.xy, life, 0.0)
      )
    );
  })().compute(TRAIL_RES * TRAIL_RES);

  // Bilinear sample of the trail map at a world xz position
  const sampleTrail = Fn(([pos]: [THREE.Node<"vec2">]) => {
    const coord = pos.div(uniforms.fieldSize).add(0.5).mul(TRAIL_RES).sub(0.5);
    const f = fract(coord);
    const c0 = clamp(floor(coord), 0.0, TRAIL_RES - 1);
    const c1 = clamp(floor(coord).add(1.0), 0.0, TRAIL_RES - 1);
    const at = (x: THREE.Node<"float">, y: THREE.Node<"float">) =>
      trailMap.element(int(y).mul(TRAIL_RES).add(int(x)));
    const trail = mix(
      mix(at(c0.x, c0.y), at(c1.x, c0.y), f.x),
      mix(at(c0.x, c1.y), at(c1.x, c1.y), f.x),
      f.y
    );
    return trail.xy.mul(recovery(trail.z));
  });

  // Static per-blade data, written by the init pass (compute-only)
  const bladeBase = instancedArray(bladeCount, "vec4"); // posX, posZ, cosRot, sinRot
  const bladeShape = instancedArray(bladeCount, "vec4"); // height, width, restBend.xz
  const bladeParams = instancedArray(bladeCount, "vec2"); // stiffness, colorVar

  // Per-frame per-blade data, packed for the vertex shader (3 vec4 per vertex)
  const bladeXform = instancedArray(bladeCount, "vec4"); // posX, posZ, scaled blade x axis
  const bladeBend = instancedArray(bladeCount, "vec4"); // linear bend.xz, cubic droop, height
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

    // Ball trail from the trail map: push direction and strength
    const trailBend = sampleTrail(grassPos).toVar();

    // Wind and trail both bend linearly with uv.y in xz and droop with uv.y^3
    const linearBend = vec2(totalWind, totalWind.mul(0.3))
      .add(trailBend)
      .toVar();
    const droop = totalWind
      .mul(totalWind)
      .mul(0.1)
      .add(dot(trailBend, trailBend).mul(0.3))
      .toVar();

    // Flattened blades are seen face-on from above, so drop the edge-on
    // thickening or they smear into wide ribbons
    const upright = smoothstep(0.0, 0.8, length(trailBend)).oneMinus();
    const xAxis = vec2(cosRot, sinRot).mul(
      widthVar.add(thicken.mul(4.0).mul(upright))
    );

    // Shadow effect from sphere
    const distanceToSphere = length(grassPos.sub(uniforms.spherePosition.xz));
    const shadowStrength = smoothstep(0.0, 2.0, distanceToSphere).oneMinus().mul(0.8);

    bladeXform.element(instanceIndex).assign(vec4(grassPos, xAxis));
    bladeBend
      .element(instanceIndex)
      .assign(vec4(linearBend, droop, heightVar));
    bladeLook
      .element(instanceIndex)
      .assign(vec4(restBend, colorVar, shadowStrength.oneMinus()));
  })().compute(bladeCount);

  const xform = bladeXform.toAttribute();
  const bend = bladeBend.toAttribute();
  const look = bladeLook.toAttribute();

  const uvY = uv().y;

  const position = Fn(() => {
    const heightVar = bend.w;
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
      uniforms.tipTint,
      smoothstep(1.0, 1.5, lightIntensity)
    );
    return tint.mul(shade).mul(lightColor).mul(lightIntensity);
  })();

  const axis = normalize(xform.zw);

  // Face normal follows the bend: cross of the blade x axis with the tangent
  // up the blade (derivative of the bent position with respect to uv.y)
  const restBend = look.xy;
  const tangentXZ = restBend.mul(uvY.mul(2.0)).add(bend.xy);
  const tangentY = bend.w
    .mul(0.6)
    .sub(dot(restBend, restBend).mul(pow(uvY, 4.0)))
    .sub(bend.z.mul(3.0).mul(uvY.mul(uvY)));
  const faceNormal = normalize(
    vec3(
      axis.y.mul(tangentY).negate(),
      axis.y.mul(tangentXZ.x).sub(axis.x.mul(tangentXZ.y)),
      axis.x.mul(tangentY)
    )
  );

  // Normal tilts across the blade, blended from a round profile to a
  // V-shaped midrib ridge. Done per fragment since the blade has no centre
  // vertices; the soft sign keeps the crease from aliasing. Flipped for
  // back faces
  const bladeX = uv().x.sub(0.5).mul(2.0);
  const roundTilt = bladeX.mul(0.75);
  const ridgeTilt = bladeX.div(abs(bladeX).add(0.12)).mul(0.6);
  const localNormal = normalize(
    varying(faceNormal).add(
      varying(vec3(axis.x, 0.0, axis.y)).mul(mix(roundTilt, ridgeTilt, uniforms.ridge))
    )
  );
  const normal = transformNormalToView(localNormal)
    .normalize()
    .mul(faceDirection);

  // Backlit glow: sunlight shining through blades seen against the sun.
  // Compared in the ground plane so a high sun still reads from a
  // downward-looking camera. Uses the flat face normal so only blades
  // turned with their back to the sun light up, each with a lime streak
  // down its middle fading to green edges
  const backlight = Fn(() => {
    const toFragment = normalize(positionWorld.xz.sub(cameraPosition.xz));
    const sunXZ = normalize(uniforms.sunDirection.xz);
    const against = smoothstep(-0.3, 1.0, dot(toFragment, sunXZ));
    const cameraSideFace = varying(faceNormal).normalize().mul(faceDirection);
    const facing = saturate(dot(cameraSideFace.xz, sunXZ).negate());
    const across = abs(uv().x.sub(0.5)).mul(2.0);
    const streak = float(1.0).sub(across.mul(across));
    const glow = against.mul(facing.mul(facing)).mul(streak).mul(uvY.mul(0.6).add(0.4));
    const glowColor = mix(vec3(0.12, 0.45, 0.03), vec3(0.4, 0.8, 0.05), streak.mul(streak));
    return glowColor.mul(glow).mul(uniforms.translucency);
  })();

  const material = new THREE.MeshPhongNodeMaterial({ side: THREE.DoubleSide });
  material.positionNode = position;
  material.colorNode = varying(color);
  material.normalNode = normal;
  material.emissiveNode = backlight;
  // Fake AO: speculars strongest at the tips, fading into the dense base
  material.specularNode = uniforms.specular.mul(smoothstep(0.0, 1.0, uvY));

  const buffers = [bladeBase, bladeShape, bladeParams, bladeXform, bladeBend, bladeLook];

  return {
    uniforms,
    init,
    clearTrail,
    stampTrail,
    update,
    material,
    dispose: () => {
      material.dispose();
      for (const buffer of [...buffers, trailMap]) buffer.value.dispose?.();
    },
  };
}

export type GrassLook = {
  specular: string;
  shininess: number;
  // Raw (non color-managed) tint multiplied into bright blade tips
  tipTint: [number, number, number];
  // Strength of the backlit glow, 0 disables it
  translucency: number;
};

export default function WebGPUGrass({
  spherePosition,
  look,
  sunPosition,
}: {
  spherePosition?: THREE.Vector3;
  look: GrassLook;
  sunPosition: [number, number, number];
}) {
  const renderer = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const needsInit = useRef(true);

  const {
    "Blade Count": bladeCount,
    "Field Size": fieldSize,
    "Blade Height": bladeHeight,
    "Wind Speed": windSpeedLeva,
    "Trail Recovery": trailRecovery,
    "Blade Ridge": bladeRidge,
  } = useControls("🌿 Grass Field", {
    "Blade Count": { value: 150000, min: 1000, max: 500000, step: 1000 },
    "Blade Height": { value: 1.3, min: 0.7, max: 4.0, step: 0.1 },
    "Field Size": { value: 50, min: 10, max: 200, step: 5 },
    "Wind Speed": { value: 1.3, min: 0.0, max: 5.0, step: 0.1 },
    "Trail Recovery": { value: 3.0, min: 0.2, max: 20.0, step: 0.1 },
    "Blade Ridge": { value: 0.6, min: 0.0, max: 1.0, step: 0.05 },
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

  useEffect(() => {
    grass.uniforms.ridge.value = bladeRidge;
  }, [grass, bladeRidge]);

  useEffect(() => {
    grass.uniforms.specular.value.set(look.specular);
    grass.material.shininess = look.shininess;
    grass.uniforms.tipTint.value.fromArray(look.tipTint);
    grass.uniforms.translucency.value = look.translucency;
    grass.uniforms.sunDirection.value.fromArray(sunPosition).normalize();
  }, [grass, look, sunPosition]);

  useFrame((state, delta) => {
    const { uniforms } = grass;
    uniforms.time.value = state.clock.elapsedTime;
    uniforms.cameraPos.value.copy(state.camera.position);

    uniforms.trailFadeStep.value = delta / trailRecovery;

    if (spherePosition) {
      uniforms.previousSpherePosition.value.copy(uniforms.spherePosition.value);
      uniforms.spherePosition.value.copy(spherePosition);
    }

    if (needsInit.current) {
      renderer.compute(grass.init);
      renderer.compute(grass.clearTrail);
      needsInit.current = false;
    }
    renderer.compute(grass.stampTrail);
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
