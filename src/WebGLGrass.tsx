import { useFrame } from "@react-three/fiber";
import { useControls } from "leva";
import { useRef, useMemo, useEffect } from "react";
import * as THREE from 'three'

const vertexWebGpuShader = `
  uniform float time;
  uniform float fieldSize;
  uniform float instanceCount;
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

    // Random height and width variation
    vec2 sizeVars = hash22(vec2(idx * 0.0019, idx * 0.0023));
    float heightVar = 1.25 + sizeVars.x * 0.8;
    float widthVar = 0.7 + sizeVars.y * 0.6;

    // Random initial bend - gives blades natural resting position
    vec2 bendVars = hash22(vec2(idx * 0.0041, idx * 0.0047));
    float bendAngle = bendVars.x * 6.28318; // Random direction 0 to 2π
    float bendMagnitude = bendVars.y * 0.25; // Random strength
    float baseBendX = cos(bendAngle) * bendMagnitude;
    float baseBendZ = sin(bendAngle) * bendMagnitude;

    // Random rotation
    float randomRotation = hash11(idx * 0.0037) * 6.28318; // 0 to 2π

    // Camera-facing calculation with falloff
    vec3 toCameraDir = normalize(cameraPosition - grassPos);
    vec3 bladeForward = vec3(sin(randomRotation), 0.0, cos(randomRotation));
    vec2 cameraDirXZ = normalize(toCameraDir.xz);
    float facingDot = bladeForward.x * cameraDirXZ.x + bladeForward.z * cameraDirXZ.y;

    // Soft billboard effect - only when almost facing camera
    float billboardStrength = smoothstep(0.3, 0.8, abs(facingDot));
    float finalRotation = mix(randomRotation, atan(toCameraDir.x, toCameraDir.z), billboardStrength * 0.6);

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

    // Apply initial bend - affects entire blade but more at top
    float bendInfluence = uv.y * uv.y; // Quadratic curve for natural bend
    vec3 initialBend = vec3(baseBendX * bendInfluence * heightVar, 0.0, baseBendZ * bendInfluence * heightVar);

    // Compensate for length due to initial bend
    float initialBendLength = length(initialBend.xz);
    initialBend.y = -initialBendLength * initialBendLength * 0.2 * uv.y;

    rotatedPos += initialBend;

    // Line-based bending - optimized without conditionals
    vec3 sphereInfluence = vec3(0.0);
    float influenceRadius = 1.75;

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
    float lineValid = step(0.1, lineLength);
    float inRange = 1.0 - step(influenceRadius, distanceToLine);
    float isActive = lineValid * inRange;

    float bendStrength = (1.0 - (distanceToLine / influenceRadius)) * isActive;
    bendStrength = smoothstep(0.0, 1.0, bendStrength);

    // Position-based falloff
    float positionAlongLine = projectionLength / safeLineLength;
    float lineFalloff = smoothstep(0.0, 1.0, positionAlongLine);
    bendStrength *= lineFalloff;

    // Bend calculation
    vec2 toPoint = grassPos.xz - closestPointOnLine;
    float pointDistance = length(toPoint);
    vec2 awayDirection = toPoint / max(pointDistance, 0.001);
    float bendAmount = bendStrength * uv.y;

    sphereInfluence.x = awayDirection.x * bendAmount;
    sphereInfluence.z = awayDirection.y * bendAmount;

    // Height compensation for bending
    float horizontalBend = length(sphereInfluence.xz);
    sphereInfluence.y = -horizontalBend * horizontalBend * 0.3 * uv.y;

    rotatedPos += sphereInfluence;

    // Noise-based wind for realistic gusts
    float windSpeed = time * 2.0;
    vec2 windCoord = grassPos.xz * 0.1 + vec2(windSpeed * 0.3, windSpeed * 0.2);

    // Multi-octave noise for complex wind patterns
    float windNoise = noise(windCoord) * 0.25;
    windNoise += noise(windCoord * 2.0) * 0.25;
    windNoise += noise(windCoord * 4.0) * 0.125;

    // Create wind gusts that move across the field
    vec2 gustCoord = grassPos.xz * 0.05 + vec2(windSpeed * 0.8, windSpeed * 0.1);
    float gustPattern = noise(gustCoord) * 0.7;

    // Combine noise patterns
    float totalWind = (windNoise + gustPattern) * 0.4;

    // Apply wind - stronger effect at blade tips
    float windInfluence = uv.y * uv.y * uv.y; // Cubic for more dramatic tip movement
    vec3 windBend = vec3(totalWind * windInfluence, 0.0, totalWind * windInfluence * 0.3);

    // Compensate for length due to wind bend
    float windBendLength = length(windBend.xz);
    windBend.y = -windBendLength * windBendLength * 0.1 * uv.y;

    rotatedPos += windBend;

    // Final position
    vec3 finalPos = rotatedPos + grassPos;
    vWorldPosition = finalPos;

    // Color variation with darker base and random hue shifts
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
    baseColor = mix(baseColor, baseColor * 1.2, colorVar);
    tipColor = mix(tipColor, tipColor * 1.2, colorVar);

    // Darker at base, brighter at tip
    float heightGradient = smoothstep(0.0, 0.8, uv.y);
    vColor = mix(baseColor * 0.4, tipColor, heightGradient);

    // Shadow effect from sphere - optimized without conditionals
    float distanceToSphere = length(grassPos.xz - spherePosition.xz);
    float shadowRadius = 2.0;

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

    // Specular calculation - intense highlights on blade tips
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 halfwayDir = normalize(lightDir + viewDir);
    float NdotH = max(dot(normal, halfwayDir), 0.0);

    // Much more intense specular, especially at blade tips
    float specular = pow(NdotH, 128.0) * 2.0; // Very high shininess and intensity

    // Amplify specular at blade tips
    float tipMultiplier = smoothstep(0.3, 1.0, vUv.y); // More specular toward tips
    specular *= (1.0 + tipMultiplier * 3.0); // Up to 4x specular at tips

    // Combine lighting
    float lighting = 0.4 + 0.6 * NdotL; // Ambient + diffuse

    // Apply lighting and specular to color
    vec3 litColor = vColor * lighting + vec3(specular);

    // Edge antialiasing - softer falloff at blade edges
    float edgeDistance = abs(vUv.x - 0.5) * 2.0; // 0 at center, 1 at edges
    float alpha = 1.0 - smoothstep(0.7, 1.0, edgeDistance);

    // Additional antialiasing at blade tip
    float tipFade = smoothstep(0.5, 1.0, vUv.y);
    alpha *= (1.0 - tipFade * 0.1);

    // Ensure minimum alpha for visibility
    alpha = max(alpha, 0.1);

    gl_FragColor = vec4(litColor, alpha);
  }
`;

export default function WebGLGrass({ spherePosition }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const oldestTrailPosition = useRef(new THREE.Vector3(0, 1, 0));

  const { "Blade Count": bladeCount, "Field Size": fieldSize } = useControls("🌿 Grass Field", {
    "Blade Count": { value: 150000, min: 1000, max: 500000, step: 1000 },
    "Field Size": { value: 50, min: 10, max: 200, step: 5 }
  });

  const geometry = useMemo(() => {
    const geom = new THREE.PlaneGeometry(0.1, 0.6, 1, 8);
    const positions = geom.attributes.position.array;
    const uvs = geom.attributes.uv.array;

    for (let i = 0; i < positions.length; i += 3) {
      const uv_y = uvs[(i / 3) * 2 + 1];
      const taper = 1.0 - uv_y * uv_y * 0.9;
      positions[i] *= taper;
    }

    geom.translate(0, 0.3, 0);
    return geom;
  }, []);

  const uniforms = useMemo(
    () => ({
      time: { value: 0 },
      fieldSize: { value: fieldSize },
      instanceCount: { value: bladeCount },
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
    }
  }, [fieldSize, bladeCount]);

  useFrame((state, delta) => {
    if (meshRef.current?.material?.uniforms) {
      meshRef.current.material.uniforms.time.value = state.clock.elapsedTime;

      if (spherePosition) {
        oldestTrailPosition.current.lerp(spherePosition, delta * 0.75);
        meshRef.current.material.uniforms.spherePosition.value.copy(spherePosition);
        meshRef.current.material.uniforms.oldestTrailPosition.value.copy(oldestTrailPosition.current);
      }
    }
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, null, bladeCount]}
      frustumCulled={false}
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