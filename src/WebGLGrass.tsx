import { useFrame } from "@react-three/fiber";
import { useControls } from "leva";
import { useRef, useMemo, useEffect } from "react";
import * as THREE from "three";
import CustomShaderMaterial from "three-custom-shader-material";

const vertexShader = `
  uniform float time;
  uniform float fieldSize;
  uniform float windSpeed;
  uniform float grassHeight;
  uniform vec3 spherePosition;
  uniform vec3 oldestTrailPosition;
  varying vec3 vGrassColor;

  // Hash functions for pseudo-random numbers
  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  // Simple noise function
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  void main() {
    // Get instance ID and generate grass position
    float idx = float(gl_InstanceID);
    vec2 randPos = hash22(vec2(idx * 0.0013, idx * 0.0017));
    float x = (randPos.x - 0.5) * fieldSize;
    float z = (randPos.y - 0.5) * fieldSize;
    vec3 grassPos = vec3(x, 0.0, z);
    vec2 grassPosXZ = grassPos.xz; // Store for reuse

    // Store uv.y for reuse
    float uvY = uv.y;

    // Random variations
    vec2 sizeVars = hash22(vec2(idx * 0.0019, idx * 0.0023));
    float heightVar = grassHeight + sizeVars.x * 0.8;
    float widthVar = 0.7 + sizeVars.y * 0.6;
    float stiffness = 0.5 + hash11(idx * 0.0071) * 0.8;
    float randomRotation = hash11(idx * 0.0037) * 6.28318;

    // Calculate sin/cos once for reuse
    float cosRot = cos(randomRotation);
    float sinRot = sin(randomRotation);

    // Random initial bend - gives blades natural resting position
    vec2 bendVars = hash22(vec2(idx * 0.0041, idx * 0.0047));
    float bendAngle = bendVars.x * 6.28318; // Random direction 0 to 2π
    float bendMagnitude = bendVars.y * 0.25; // Random strength
    float baseBendX = cos(bendAngle) * bendMagnitude;
    float baseBendZ = sin(bendAngle) * bendMagnitude;

    // View-space thickening - calculate BEFORE rotation
    vec2 viewDirXZ = normalize(cameraPosition.xz - grassPosXZ);
    // The blade faces perpendicular to its rotation (reuse sin/cos)
    vec2 grassFaceNormal = vec2(-sinRot, cosRot);
    float viewDotNormal = clamp(abs(dot(grassFaceNormal, viewDirXZ)), 0.0, 1.0);
    float viewSpaceThickenFactor = pow(1.0 - viewDotNormal, 2.0);

    // Transform position
    vec3 scaledPos = position;
    scaledPos.xz *= widthVar;
    scaledPos.xz += position.xz * viewSpaceThickenFactor * 4.0;
    scaledPos.y *= heightVar;

    // Rotate (reuse sin/cos)
    vec3 rotatedPos = scaledPos;
    rotatedPos.x = scaledPos.x * cosRot - scaledPos.z * sinRot;
    rotatedPos.z = scaledPos.x * sinRot + scaledPos.z * cosRot;

    // Apply initial bend with natural curve
    float uvYSq = uvY * uvY;
    float bendInfluence = uvYSq * heightVar; // Quadratic curve for natural bend
    vec3 initialBend = vec3(baseBendX * bendInfluence, 0.0, baseBendZ * bendInfluence);

    // Combine length compensation in one operation
    float bendLengthSq = dot(initialBend.xz, initialBend.xz);
    initialBend.y = -bendLengthSq * 0.2 * uvY;

    rotatedPos += initialBend;

    // Wind system
    float windTime = time * windSpeed;
    vec2 detailCoord = grassPosXZ * 0.1 + vec2(windTime * -0.4, windTime * -0.2);
    float windDetail = noise(detailCoord) * 0.4;
    vec2 gustCoord = grassPosXZ * 0.03 + vec2(windTime * -0.6, windTime * -0.5);
    float gustBase = noise(gustCoord) * 0.4;
    float totalWind = (windDetail + gustBase) * windSpeed / stiffness - windSpeed * 0.5;

    // Apply wind
    float windInfluence = uvY * totalWind;
    vec3 windBend = vec3(windInfluence, -windInfluence * windInfluence * 0.1 * uvY, windInfluence * 0.3);
    rotatedPos += windBend;

    // Line-based bending for sphere trail
    vec3 sphereInfluence = vec3(0.0);
    float influenceRadius = 1.45;

    vec2 lineStart = oldestTrailPosition.xz;
    vec2 lineEnd = spherePosition.xz;
    vec2 lineVector = lineEnd - lineStart;
    float lineLength = length(lineVector);

    // Avoid division by zero with max
    float safeLineLength = max(lineLength, 0.001);
    vec2 lineDirection = lineVector / safeLineLength;

    // Find closest point on line to grass position
    vec2 toGrass = grassPosXZ - lineStart;
    float projectionLength = clamp(dot(toGrass, lineDirection), 0.0, safeLineLength);
    vec2 closestPointOnLine = lineStart + lineDirection * projectionLength;
    float distanceToLine = length(grassPosXZ - closestPointOnLine);

    float bendStrength = (1.0 - (distanceToLine / influenceRadius));
    bendStrength = smoothstep(0.0, 1.0, bendStrength);

    // Position-based falloff along the trail
    float positionAlongLine = projectionLength / safeLineLength;
    float lineFalloff = smoothstep(0.0, 1.0, positionAlongLine);
    bendStrength *= lineFalloff;

    // Bend calculation
    vec2 toPoint = grassPosXZ - closestPointOnLine;
    float pointDistance = length(toPoint);
    vec2 awayDirection = toPoint / max(pointDistance, 0.001);
    float bendAmount = bendStrength * 1.3 * uvY;

    sphereInfluence.x = awayDirection.x * bendAmount;
    sphereInfluence.z = awayDirection.y * bendAmount;

    // Height compensation for bending (optimized: awayDirection is normalized)
    sphereInfluence.y = -bendAmount * bendAmount * 0.3 * uvY;

    rotatedPos += sphereInfluence;

    // Simplified color variation - single hash for all color properties
    float colorVar = hash11(idx * 0.0031);

    // Base warm green with simple variation
    vec3 baseGreen = vec3(0.15, 0.8, 0.15);
    vec3 variation = vec3(0.1, 0.3, 0.05); // RGB variation amounts

    // Apply variation using single lerp
    vGrassColor = baseGreen + variation * (colorVar - 0.5) * 2.0;

    // Shadow effect from sphere
    float distanceToSphere = length(grassPosXZ - spherePosition.xz);
    float shadowRadius = 2.;
    float shadowStrength = smoothstep(shadowRadius, 0.0, distanceToSphere) * 0.8;
    vGrassColor *= (1.0 - shadowStrength);

    // Calculate lighting modifier with yellow tint at tips - all in vertex
    float linearModifier = uvY + .1;
    float tipFactor = (uvY - 0.66) * 3.0;
    float tipModifier = 0.8 + tipFactor * tipFactor * 2.5;
    float lightIntensity = mix(linearModifier, tipModifier, step(0.75, uvY));

    // Apply yellow tint to bright areas in vertex shader
    vec3 lightColor = mix(vec3(1.0), vec3(1.0, 0.9, 0.6), smoothstep(1.0, 1.5, lightIntensity));
    vGrassColor *= lightColor * lightIntensity;

    // Calculate rounded normal for cylindrical appearance
    vec3 localNormal = normal;
    // Create rounded effect by modifying normal based on UV.x position
    float roundness = (uv.x - 0.5) * 2.0; // -1 to 1 across width
    localNormal.x = roundness * 0.75; // Curve the normal
    localNormal = normalize(localNormal);

    // Update position and normal for CSM
    csm_Position = rotatedPos + grassPos;
    csm_Normal = localNormal;
  }
`;

const fragmentShader = `
  varying vec3 vGrassColor;

  void main() {
    // Ultra-minimal fragment shader - all calculations done in vertex
    csm_DiffuseColor = vec4(vGrassColor, 1.0);
  }
`;

export default function WebGLGrass({
  spherePosition,
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const oldestTrailPosition = useRef(new THREE.Vector3(0, 1, 0));

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

    const geometry = useMemo(() => {
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
      vertices.push(0, tipV * height, 0); // Single vertex at center
      uvs.push(0.5, tipV); // UV at center
  
      // Create indices - quads for body, triangles for tip
      for (let y = 0; y < yPositions.length - 2; y++) {
        const base = y * 2;
        // Two triangles forming a quad
        indices.push(base, base + 1, base + 2);
        indices.push(base + 1, base + 3, base + 2);
      }
  
      // Create tip triangle (connect last quad to single tip vertex)
      const lastQuadBase = (yPositions.length - 2) * 2;
      const tipVertexIndex = lastQuadBase + 2;

      // Single triangle from last quad edge to tip
      indices.push(lastQuadBase, lastQuadBase + 1, tipVertexIndex);
  
      const geom = new THREE.BufferGeometry();
      geom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(vertices, 3)
      );
      geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geom.setIndex(indices);
      geom.computeVertexNormals();
  
      return geom;
    }, []);

  const uniforms = useMemo(
    () => ({
      time: { value: 0 },
      fieldSize: { value: fieldSize },
      windSpeed: { value: windSpeedLeva },
      grassHeight: { value: bladeHeight },
      spherePosition: { value: new THREE.Vector3(0, 1, 0) },
      oldestTrailPosition: { value: new THREE.Vector3(0, 1, 0) },
    }),
    []
  );

  // Update uniforms when Leva values change
  useEffect(() => {
    if (meshRef.current?.material?.uniforms) {
      meshRef.current.material.uniforms.fieldSize.value = fieldSize;
      meshRef.current.material.uniforms.windSpeed.value = windSpeedLeva;
      meshRef.current.material.uniforms.grassHeight.value = bladeHeight;
    }
  }, [fieldSize, windSpeedLeva, bladeHeight]);

  useFrame((state, delta) => {
    if (meshRef.current?.material?.uniforms) {
      // Always update time for smooth animation
      meshRef.current.material.uniforms.time.value = state.clock.elapsedTime;

      // Update sphere position and trail every frame for responsiveness
      if (spherePosition) {
        oldestTrailPosition.current.lerp(spherePosition, delta * 0.6);
        meshRef.current.material.uniforms.spherePosition.value.copy(
          spherePosition
        );
        meshRef.current.material.uniforms.oldestTrailPosition.value.copy(
          oldestTrailPosition.current
        );
      }
    }
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, null, bladeCount]}
      frustumCulled={false}
      key={bladeCount}
    >
      <CustomShaderMaterial
        baseMaterial={THREE.MeshLambertMaterial}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        side={THREE.DoubleSide}
        transparent
      />
    </instancedMesh>
  );
}
