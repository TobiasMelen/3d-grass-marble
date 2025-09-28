import { useFrame } from "@react-three/fiber";
import { useControls } from "leva";
import { useRef, useMemo, useEffect } from "react";
import * as THREE from 'three'

const vertexWebGpuShader = `
  uniform float time;
  uniform float fieldSize;
  uniform float instanceCount;
  uniform float windSpeed;
  uniform float grassHeight;
  uniform vec3 spherePosition;
  uniform vec3 oldestTrailPosition;
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  // Improved hash functions for pseudo-random numbers
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

  // Simple noise function for wind
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

  // Function to calculate bending from any position
  vec3 calculateBending(vec3 fromPosition, float strength, vec2 grassPos, float influenceRadius, float uvY) {
    float distance = length(grassPos - fromPosition.xz);
    if (distance < influenceRadius) {
      float bendStrength = 1.0 - (distance / influenceRadius);
      bendStrength = smoothstep(0.0, 1.0, bendStrength);

      vec2 awayDirection = normalize(grassPos - fromPosition.xz);
      float bendAmount = bendStrength * uvY * strength;

      return vec3(awayDirection.x * bendAmount, 0.0, awayDirection.y * bendAmount);
    }
    return vec3(0.0);
  }

  void main() {
    vUv = uv;

    // Get instance ID
    float idx = float(gl_InstanceID);

    // Generate position within fixed field size using improved hash
    // Use multiple seeds to avoid correlation between x and z coordinates
    vec2 randPos = hash22(vec2(idx * 0.0013, idx * 0.0017));
    float x = (randPos.x - 0.5) * fieldSize;
    float z = (randPos.y - 0.5) * fieldSize;

    vec3 grassPos = vec3(x, 0.0, z);

    // Distance-based LOD: reduce detail for far grass
    float distanceToCamera = length(cameraPosition - grassPos);
    float lodFactor = smoothstep(20.0, 60.0, distanceToCamera); // Start reducing at 20m, full reduction at 60m

    // Better distributed random values - keep quality but optimize
    vec2 sizeVars = hash22(vec2(idx * 0.0019, idx * 0.0023));
    float heightVar = grassHeight + sizeVars.x * 0.8;
    float widthVar = 0.7 + sizeVars.y * 0.6;

    // Separate random values for different properties to avoid correlation
    float stiffnessVar = hash11(idx * 0.0071);
    float stiffness = 0.5 + stiffnessVar * 0.8; // Range: 0.5 to 1.3

    // Random rotation with better distribution
    float randomRotation = hash11(idx * 0.0037) * 6.28318; // 0 to 2π

    // Random initial bend with independent values
    vec2 bendVars = hash22(vec2(idx * 0.0041, idx * 0.0047));
    float bendAngle = bendVars.x * 6.28318; // Random direction 0 to 2π
    float bendMagnitude = bendVars.y * 0.25; // Random strength
    float baseBendX = cos(bendAngle) * bendMagnitude;
    float baseBendZ = sin(bendAngle) * bendMagnitude;

    // Simplified billboard effect using dot product
    vec2 toCameraXZ = normalize(cameraPosition.xz - grassPos.xz);

    // Current blade direction from rotation
    vec2 bladeDir = vec2(cos(randomRotation), sin(randomRotation));

    // How aligned is blade with camera direction (0 = perpendicular, 1 = aligned)
    float alignment = abs(dot(bladeDir, toCameraXZ));

    // Billboard strength when blade is edge-on (highly aligned)
    float billboardStrength = smoothstep(0.3, 0.9, alignment) * 0.7;

    // Optimal angle perpendicular to camera
    float optimalAngle = atan(toCameraXZ.y, toCameraXZ.x) + 1.5708;
    float finalRotation = mix(randomRotation, optimalAngle, billboardStrength);

    // Apply rotation to blade
    float cosRot = cos(finalRotation);
    float sinRot = sin(finalRotation);

    // Scale the blade
    vec3 scaledPos = position;
    scaledPos.xz *= widthVar;
    scaledPos.y *= heightVar;

    // Rotate around Y axis
    vec3 rotatedPos = scaledPos;
    rotatedPos.x = scaledPos.x * cosRot - scaledPos.z * sinRot;
    rotatedPos.z = scaledPos.x * sinRot + scaledPos.z * cosRot;

    // Apply initial bend with combined calculations
    float bendInfluence = uv.y * uv.y * heightVar; // Quadratic curve for natural bend
    vec3 initialBend = vec3(baseBendX * bendInfluence, 0.0, baseBendZ * bendInfluence);

    // Combine length compensation in one operation
    float bendLengthSq = dot(initialBend.xz, initialBend.xz);
    initialBend.y = -bendLengthSq * 0.2 * uv.y;

    rotatedPos += initialBend;

    // Line-based bending - optimized without conditionals
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
    vec2 toGrass = grassPos.xz - lineStart;
    float projectionLength = clamp(dot(toGrass, lineDirection), 0.0, safeLineLength);
    vec2 closestPointOnLine = lineStart + lineDirection * projectionLength;
    float distanceToLine = length(grassPos.xz - closestPointOnLine);

    // Use step functions instead of conditionals
    float inRange = 1.0 - step(influenceRadius, distanceToLine);

    float bendStrength = (1.0 - (distanceToLine / influenceRadius));
    bendStrength = smoothstep(0.0, 1.0, bendStrength);

    // Position-based falloff
    float positionAlongLine = projectionLength / safeLineLength;
    float lineFalloff = smoothstep(0.0, 1.0, positionAlongLine);
    bendStrength *= lineFalloff;

    // Bend calculation
    vec2 toPoint = grassPos.xz - closestPointOnLine;
    float pointDistance = length(toPoint);
    vec2 awayDirection = toPoint / max(pointDistance, 0.001);
    float bendAmount = bendStrength * 1.3 * uv.y;

    sphereInfluence.x = awayDirection.x * bendAmount;
    sphereInfluence.z = awayDirection.y * bendAmount;

    // Height compensation for bending
    float horizontalBend = length(sphereInfluence.xz);
    sphereInfluence.y = -horizontalBend * horizontalBend * 0.3 * uv.y;

    rotatedPos += sphereInfluence;

    // Two-layer wind system: fine detail + powerful gusts
    float windTime = time * windSpeed;

    // Fine wind detail - small scale, constant gentle movement
    vec2 detailCoord = grassPos.xz * 0.1 + vec2(windTime * -0.4, windTime * -0.2);
    float windDetail = noise(detailCoord) * 0.4;

    // Powerful gusts - large scale, strong intermittent waves
    vec2 gustCoord = grassPos.xz * 0.03 + vec2(windTime * -0.6, windTime * -0.5);
    float gustBase = noise(gustCoord) * 0.4;

    // Combine layers and apply stiffness
    float totalWind = (windDetail + gustBase) * windSpeed / stiffness - windSpeed * 0.5;

    // Apply wind with combined calculations
    float windInfluence = uv.y * totalWind;
    vec3 windBend = vec3(windInfluence, 0.0, windInfluence * 0.3);

    // Combine wind length compensation
    float windLengthSq = dot(windBend.xz, windBend.xz);
    windBend.y = -windLengthSq * 0.1 * uv.y;

    rotatedPos += windBend;

    // Final position
    vec3 finalPos = rotatedPos + grassPos;
    vWorldPosition = finalPos;

    // Independent color variations for proper randomization
    float colorVar = hash11(idx * 0.0031);
    float hueVar = hash11(idx * 0.0053); // Additional randomness for hue
    float satVar = hash11(idx * 0.0067); // Saturation variation

    // Base green colors
    vec3 baseGreen = vec3(0.08, 0.25, 0.08);
    vec3 tipGreen = vec3(0.2, 0.6, 0.2);

    // Variations: darker greens, yellower greens, and brighter greens - more prominent
    vec3 darkGreen = vec3(0.03, 0.12, 0.03);
    vec3 yellowGreen = vec3(0.22, 0.28, 0.06);
    vec3 brightGreen = vec3(0.18, 0.45, 0.18);

    vec3 darkTip = vec3(0.1, 0.35, 0.1);
    vec3 yellowTip = vec3(0.5, 0.8, 0.15);
    vec3 brightTip = vec3(0.35, 0.9, 0.35);

    // Mix base colors without conditionals - use step functions
    float isDark = step(hueVar, 0.3);
    float isYellow = step(hueVar, 0.7) * (1.0 - isDark);
    float isBright = 1.0 - step(hueVar, 0.7);

    // Blend colors based on category weights
    vec3 darkBase = mix(baseGreen, darkGreen, satVar * 1.2);
    vec3 darkTipCol = mix(tipGreen, darkTip, satVar * 1.2);

    vec3 yellowBase = mix(baseGreen, yellowGreen, satVar);
    vec3 yellowTipCol = mix(tipGreen, yellowTip, satVar);

    vec3 brightBase = mix(baseGreen, brightGreen, satVar * 1.2);
    vec3 brightTipCol = mix(tipGreen, brightTip, satVar * 1.2);

    vec3 baseColor = darkBase * isDark + yellowBase * isYellow + brightBase * isBright;
    vec3 tipColor = darkTipCol * isDark + yellowTipCol * isYellow + brightTipCol * isBright;

    // Final color mixing with original variation
    baseColor = mix(baseColor, baseColor * 1.6, colorVar);
    tipColor = mix(tipColor, tipColor * 1.6, colorVar);

    // Darker at base, brighter at tip
    float heightGradient = smoothstep(0., 1., uv.y);
    vColor = mix(baseColor, tipColor, heightGradient);

    // Shadow effect from sphere - optimized without conditionals
    float distanceToSphere = length(grassPos.xz - spherePosition.xz);
    float shadowRadius = 1.65;

    // Use step and clamp instead of conditional
    float inShadowRange = 1.0 - step(shadowRadius, distanceToSphere);
    float shadowStrength = clamp(1.0 - (distanceToSphere / shadowRadius), 0.0, 1.0) * inShadowRange;
    shadowStrength = smoothstep(0.0, 1.0, shadowStrength);

    // Apply shadow unconditionally
    float darkenAmount = shadowStrength * 0.8;
    vColor *= (1.0 - darkenAmount);

    // Calculate rounded normal for cylindrical appearance
    vec3 localNormal = normal;
    // Create rounded effect by modifying normal based on UV.x position
    float roundness = (uv.x - 0.5) * 2.0; // -1 to 1 across width
    localNormal.x = roundness * 0.75; // Curve the normal
    localNormal = normalize(localNormal);

    // Transform normal to world space (simplified)
    vNormal = normalize(localNormal);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(finalPos, 1.0);
  }
`;

const fragmentWebGpuShader = `
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  void main() {
    // Basic lighting calculation
    vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));
    vec3 normal = normalize(vNormal);
    float NdotL = max(dot(normal, lightDir), 0.0);

    // Combine lighting - stronger directional, less ambient
    float lighting = 0.33 + 0.7 * NdotL; // Reduced ambient + stronger diffuse

    // Apply lighting and specular to color
    vec3 litColor = vColor * lighting;

    gl_FragColor = vec4(litColor, 1.);
  }
`;

export default function WebGLGrass({ spherePosition, windSpeed = 1.0, grassHeight = 1.25 }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const oldestTrailPosition = useRef(new THREE.Vector3(0, 1, 0));

  const { "Blade Count": bladeCount, "Field Size": fieldSize, "Blade Height": bladeHeight, "Wind Speed": windSpeedLeva } = useControls("🌿 Grass Field", {
    "Blade Count": { value: 150000, min: 1000, max: 500000, step: 1000 },
    "Blade Height": { value: 1.3, min: 0.7, max: 4.0, step: 0.1 },
    "Field Size": { value: 50, min: 10, max: 200, step: 5 },
    "Wind Speed": { value: 1.3, min: 0.0, max: 5.0, step: 0.1 },
  });

  const geometry = useMemo(() => {
    // Create custom geometry with segments concentrated at the tip
    const width = 0.1;
    const height = 0.6;
    const segments = 5; // Total segments

    // Custom Y distribution - more segments at top, single quad at bottom
    // Start from bottom and work up to full height
    const yPositions = [
      0.0,    // Ground level
      0.25,   // Bottom-mid (single large segment)
      0.5,    // Mid
      0.8,    // Upper-mid
      0.9,    // Near tip
      1.0     // Tip
    ];

    const vertices = [];
    const uvs = [];
    const indices = [];

    // Create vertices
    for (let y = 0; y <= segments; y++) {
      const v = yPositions[y];
      const taper = 1.0 - v * v * 0.9; // Apply tapering

      // Left and right vertices
      vertices.push(-width * 0.5 * taper, v * height, 0); // Left
      vertices.push(width * 0.5 * taper, v * height, 0);  // Right

      // UVs
      uvs.push(0, v);
      uvs.push(1, v);
    }

    // Create indices for triangles
    for (let y = 0; y < segments; y++) {
      const base = y * 2;

      // Two triangles per segment
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    // Don't translate - let the geometry start at ground level
    // geom.translate(0, 0.3, 0);
    return geom;
  }, []);

  const uniforms = useMemo(
    () => ({
      time: { value: 0 },
      fieldSize: { value: fieldSize },
      instanceCount: { value: bladeCount },
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
      meshRef.current.material.uniforms.instanceCount.value = bladeCount;
      meshRef.current.material.uniforms.windSpeed.value = windSpeedLeva;
      meshRef.current.material.uniforms.grassHeight.value = bladeHeight;
    }
  }, [fieldSize, bladeCount, windSpeedLeva, bladeHeight]);

  useFrame((state, delta) => {
    if (meshRef.current?.material?.uniforms) {
      // Always update time for smooth animation
      meshRef.current.material.uniforms.time.value = state.clock.elapsedTime;

      // Update sphere position every frame for responsiveness
      if (spherePosition) {
        oldestTrailPosition.current.lerp(spherePosition, delta * 0.6);
        meshRef.current.material.uniforms.spherePosition.value.copy(spherePosition);
        meshRef.current.material.uniforms.oldestTrailPosition.value.copy(oldestTrailPosition.current);
      }
    }
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, null, bladeCount]}
      frustumCulled={false} // Enable frustum culling for better performance
      key={bladeCount} // Force recreation when blade count changes
    >
      <shaderMaterial
        vertexShader={vertexWebGpuShader}
        fragmentShader={fragmentWebGpuShader}
        uniforms={uniforms}
        side={THREE.DoubleSide}
        transparent
      />
    </instancedMesh>
  );
}