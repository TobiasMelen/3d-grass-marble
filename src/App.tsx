import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

const vertexShader = `
  uniform float time;
  uniform float fieldSize;
  uniform float instanceCount;
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
    float heightVar = 0.5 + sizeVars.x * 0.8;
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
    rotatedPos.x += baseBendX * bendInfluence * heightVar;
    rotatedPos.z += baseBendZ * bendInfluence * heightVar;

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
    rotatedPos.x += totalWind * windInfluence;
    rotatedPos.z += totalWind * windInfluence * 0.3; // Less Z movement

    // Final position
    vec3 finalPos = rotatedPos + grassPos;
    vWorldPosition = finalPos;

    // Color variation with darker base
    float colorVar = hash11(idx * 0.0031);
    vec3 baseColor = mix(vec3(0.08, 0.25, 0.08), vec3(0.15, 0.5, 0.15), colorVar);
    vec3 tipColor = mix(vec3(0.2, 0.6, 0.2), vec3(0.3, 0.8, 0.3), colorVar);

    // Darker at base, brighter at tip
    float heightGradient = smoothstep(0.0, 0.8, uv.y);
    vColor = mix(baseColor * 0.4, tipColor, heightGradient);

    // Calculate rounded normal for cylindrical appearance
    vec3 localNormal = normal;
    // Create rounded effect by modifying normal based on UV.x position
    float roundness = (uv.x - 0.5) * 2.0; // -1 to 1 across width
    localNormal.x = roundness * 0.8; // Curve the normal
    localNormal = normalize(localNormal);

    // Transform normal to world space (simplified)
    vNormal = normalize(localNormal);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(finalPos, 1.0);
  }
`;

const fragmentShader = `
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  void main() {
    // Basic lighting calculation
    vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));
    vec3 normal = normalize(vNormal);
    float NdotL = max(dot(normal, lightDir), 0.0);

    // Specular calculation
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 halfwayDir = normalize(lightDir + viewDir);
    float NdotH = max(dot(normal, halfwayDir), 0.0);
    float specular = pow(NdotH, 40.0) * 0.3; // Shininess = 32, intensity = 0.3

    // Combine lighting
    float lighting = 0.4 + 0.6 * NdotL; // Ambient + diffuse

    // Apply lighting and specular to color
    vec3 litColor = vColor * lighting + vec3(specular);

    // Edge antialiasing - softer falloff at blade edges
    float edgeDistance = abs(vUv.x - 0.5) * 2.0; // 0 at center, 1 at edges
    float alpha = 1.0 - smoothstep(0.7, 1.0, edgeDistance);

    // // Additional antialiasing at blade tip
    float tipFade = smoothstep(0.5, 1.0, vUv.y);
    alpha *= (1.0 - tipFade * 0.1);

    // // Ensure minimum alpha for visibility
    alpha = max(alpha, 0.1);

    //gl_FragColor = vec4(litColor, 1.);
    gl_FragColor = vec4(litColor, alpha);
  }
`;

function Grass() {
  const meshRef = useRef();
  const count = 150_000; // Number of grass blades (affects density only)
  const fieldSize = 50; // Size of grass field (always constant)
  
  const geometry = useMemo(() => {
    // Create detailed blade geometry with more segments for LOD
    const geom = new THREE.PlaneGeometry(0.1, 0.6, 1, 8);

    // Make it pointy by modifying vertices
    const positions = geom.attributes.position.array;
    const uvs = geom.attributes.uv.array;

    for (let i = 0; i < positions.length; i += 3) {
      const y = positions[i + 1];
      const uv_y = uvs[(i / 3) * 2 + 1];

      // Taper the blade towards the top to make it pointy
      const taper = 1.0 - (uv_y * uv_y * 0.9); // Quadratic taper
      positions[i] *= taper; // Scale x position
    }

    geom.translate(0, 0.3, 0); // Move pivot to base
    return geom;
  }, []);
  
  const uniforms = useMemo(() => ({
    time: { value: 0 },
    fieldSize: { value: fieldSize },
    instanceCount: { value: count }
  }), [count, fieldSize]);
  
  useFrame((state) => {
    if (meshRef.current) {
      meshRef.current.material.uniforms.time.value = state.clock.elapsedTime;
    }
  });
  
  return (
    <instancedMesh ref={meshRef} args={[geometry, null, count]}>
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        side={THREE.DoubleSide}
        transparent
      />
    </instancedMesh>
  );
}

function Ground() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
      <planeGeometry args={[50, 50]} />
      <meshStandardMaterial color="#2d5016" />
    </mesh>
  );
}

export default function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Canvas camera={{ position: [15, 10, 15], fov: 60 }}>
        <color attach="background" args={['#87ceeb']} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[10, 10, 5]} intensity={1} />
        
        <Ground />
        <Grass />
        
        <OrbitControls 
          minPolarAngle={0}
          maxPolarAngle={Math.PI / 2.1}
          enableDamping
        />
      </Canvas>
      <div style={{
        position: 'absolute',
        top: 20,
        left: 20,
        color: 'white',
        background: 'rgba(0,0,0,0.5)',
        padding: '10px',
        borderRadius: '5px',
        fontFamily: 'monospace'
      }}>
        1,000,000 grass blades<br/>
        Field size: 50x50 units
      </div>
    </div>
  );
}