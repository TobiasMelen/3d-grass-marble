import React, { useRef, useMemo, useState, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

const vertexShader = `
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

    // Line-based bending - bend away from the entire sphere trail line
    vec3 sphereInfluence = vec3(0.0);
    float influenceRadius = 1.75;

    vec2 lineStart = oldestTrailPosition.xz;
    vec2 lineEnd = spherePosition.xz;
    vec2 lineVector = lineEnd - lineStart;
    float lineLength = length(lineVector);

    if (lineLength > 0.1) {
      vec2 lineDirection = lineVector / lineLength;

      // Find closest point on line to grass position
      vec2 toGrass = grassPos.xz - lineStart;
      float projectionLength = dot(toGrass, lineDirection);
      projectionLength = clamp(projectionLength, 0.0, lineLength);

      vec2 closestPointOnLine = lineStart + lineDirection * projectionLength;
      float distanceToLine = length(grassPos.xz - closestPointOnLine);

      if (distanceToLine < influenceRadius) {
        float bendStrength = 1.0 - (distanceToLine / influenceRadius);
        bendStrength = smoothstep(0.0, 1.0, bendStrength);

        // Add falloff based on position along the line
        // 0.0 = oldest position (weak), 1.0 = current position (strong)
        float positionAlongLine = projectionLength / lineLength;
        float lineFalloff = smoothstep(0.0, 1.0, positionAlongLine);

        bendStrength *= lineFalloff;

        // Bend away from closest point on trail line
        vec2 awayDirection = normalize(grassPos.xz - closestPointOnLine);
        float bendAmount = bendStrength * uv.y;

        sphereInfluence.x = awayDirection.x * bendAmount;
        sphereInfluence.z = awayDirection.y * bendAmount;
      }
    }

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

    // Mix base colors based on hue variation
    vec3 baseColor, tipColor;
    if (hueVar < 0.3) {
        // Darker green variation
        baseColor = mix(baseGreen, darkGreen, satVar * 1.2);
        tipColor = mix(tipGreen, darkTip, satVar * 1.2);
    } else if (hueVar < 0.7) {
        // Yellow-green variation
        baseColor = mix(baseGreen, yellowGreen, satVar * 1.0);
        tipColor = mix(tipGreen, yellowTip, satVar * 1.0);
    } else {
        // Brighter green variation
        baseColor = mix(baseGreen, brightGreen, satVar * 1.2);
        tipColor = mix(tipGreen, brightTip, satVar * 1.2);
    }

    // Final color mixing with original variation
    baseColor = mix(baseColor, baseColor * 1.2, colorVar);
    tipColor = mix(tipColor, tipColor * 1.2, colorVar);

    // Darker at base, brighter at tip
    float heightGradient = smoothstep(0.0, 0.8, uv.y);
    vColor = mix(baseColor * 0.4, tipColor, heightGradient);

    // Shadow effect from sphere
    float distanceToSphere = length(grassPos.xz - spherePosition.xz);
    float shadowRadius = 2.; // Radius of shadow effect
    if (distanceToSphere < shadowRadius) {
      float shadowStrength = 1.0 - (distanceToSphere / shadowRadius);
      shadowStrength = smoothstep(0.0, 1.0, shadowStrength);

      // Darken the grass based on proximity to sphere
      float darkenAmount = shadowStrength * 0.8; // 60% darker at maximum
      vColor *= (1.0 - darkenAmount);
    }

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

    // // Additional antialiasing at blade tip
    float tipFade = smoothstep(0.5, 1.0, vUv.y);
    alpha *= (1.0 - tipFade * 0.1);

    // // Ensure minimum alpha for visibility
    alpha = max(alpha, 0.1);

    //gl_FragColor = vec4(litColor, 1.);
    gl_FragColor = vec4(litColor, alpha);
  }
`;

function Grass({ spherePosition }) {
  const meshRef = useRef();
  const count = 150_000; // Number of grass blades (affects density only)
  const fieldSize = 50; // Size of grass field (always constant)
  const oldestTrailPosition = useRef(new THREE.Vector3(0, 1, 0));

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
      const taper = 1.0 - uv_y * uv_y * 0.9; // Quadratic taper
      positions[i] *= taper; // Scale x position
    }

    geom.translate(0, 0.3, 0); // Move pivot to base
    return geom;
  }, []);

  const uniforms = useMemo(
    () => ({
      time: { value: 0 },
      fieldSize: { value: fieldSize },
      instanceCount: { value: count },
      spherePosition: { value: new THREE.Vector3(0, 1, 0) },
      oldestTrailPosition: { value: new THREE.Vector3(0, 1, 0) },
    }),
    [count, fieldSize]
  );

  useFrame((state, delta) => {
    if (meshRef.current) {
      meshRef.current.material.uniforms.time.value = state.clock.elapsedTime;

      if (spherePosition) {
        // Slowly move the oldest trail position towards current sphere position
        // This creates a line that represents the sphere's path
        oldestTrailPosition.current.lerp(spherePosition, delta * 0.75); // Even slower follow creates longer trail

        // Update uniforms
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
      args={[geometry, null, count]}
      frustumCulled={false}
    >
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

const Ground = React.forwardRef((props, ref) => {
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
      <planeGeometry args={[50, 50]} />
      <meshStandardMaterial color="#2d5016" />
    </mesh>
  );
});

function KineticSphere({ onPositionChange, groundRef }) {
  const meshRef = useRef();
  const velocity = useRef(new THREE.Vector3());
  const keys = useRef({ w: false, a: false, s: false, d: false });
  const mouseTarget = useRef(null);
  const isMousePressed = useRef(false);

  useEffect(() => {
    const handleKeyDown = (event) => {
      switch (event.code) {
        case "KeyW":
          keys.current.w = true;
          break;
        case "KeyA":
          keys.current.a = true;
          break;
        case "KeyS":
          keys.current.s = true;
          break;
        case "KeyD":
          keys.current.d = true;
          break;
      }
    };

    const handleKeyUp = (event) => {
      switch (event.code) {
        case "KeyW":
          keys.current.w = false;
          break;
        case "KeyA":
          keys.current.a = false;
          break;
        case "KeyS":
          keys.current.s = false;
          break;
        case "KeyD":
          keys.current.d = false;
          break;
      }
    };

    const handleMouseDown = (event) => {
      isMousePressed.current = true;
    };

    const handleMouseUp = (event) => {
      isMousePressed.current = false;
      mouseTarget.current = null;
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  useFrame((state, delta) => {
    if (!meshRef.current) return;

    // Handle mouse raycasting for ground clicks
    if (isMousePressed.current && groundRef?.current) {
      const raycaster = new THREE.Raycaster();
      const mouse = new THREE.Vector2();

      // Calculate mouse position in normalized device coordinates
      mouse.x = state.pointer.x;
      mouse.y = state.pointer.y;

      raycaster.setFromCamera(mouse, state.camera);

      // Intersect with ground mesh
      const intersects = raycaster.intersectObject(groundRef.current);

      if (intersects.length > 0) {
        mouseTarget.current = intersects[0].point;
      }
    }

    const force = new THREE.Vector3();
    const forceStrength = 8; // Reduced for heavier feel

    // Apply forces based on key input
    if (keys.current.w) force.z -= forceStrength;
    if (keys.current.s) force.z += forceStrength;
    if (keys.current.a) force.x -= forceStrength;
    if (keys.current.d) force.x += forceStrength;

    // Apply mouse-directed force
    if (mouseTarget.current && isMousePressed.current) {
      const direction = mouseTarget.current
        .clone()
        .sub(meshRef.current.position);
      direction.y = 0; // Only horizontal movement
      direction.normalize();

      // Use same force strength as keyboard
      force.add(direction.multiplyScalar(forceStrength));
    }

    // Apply physics with more momentum
    velocity.current.add(force.multiplyScalar(delta));
    velocity.current.multiplyScalar(0.98); // Much less friction for longer coasting

    // Update position
    meshRef.current.position.add(
      velocity.current.clone().multiplyScalar(delta)
    );

    // Keep sphere on ground
    meshRef.current.position.y = 1.0; // New sphere radius

    // Rotation based on movement
    const speed = velocity.current.length();
    if (speed > 0.05) {
      const axis = new THREE.Vector3(
        -velocity.current.z,
        0,
        velocity.current.x
      ).normalize();
      meshRef.current.rotateOnAxis(axis, speed * delta * 0.05);
    }

    // Notify parent of position change
    if (onPositionChange) {
      onPositionChange(meshRef.current.position);
    }
  });

  return (
    <mesh ref={meshRef} position={[0, 1.0, 0]}>
      <sphereGeometry args={[1.0, 32, 32]} />
      <meshPhongMaterial shininess={350} color="#F44"
      />
    </mesh>
  );
}

function CameraController({ spherePosition, cameraMode }) {
  const { camera } = useThree();
  const orbitRef = useRef();

  useFrame(() => {
    if (cameraMode === "third-person" && spherePosition) {
      // Third-person camera follows sphere - closer to ground
      const offset = new THREE.Vector3(0, 2.5, 6);
      const targetPosition = spherePosition.clone().add(offset);

      camera.position.lerp(targetPosition, 0.1);
      camera.lookAt(spherePosition.x, spherePosition.y, spherePosition.z);
    }
  });

  return cameraMode === "orbit" ? (
    <OrbitControls
      ref={orbitRef}
      minPolarAngle={0}
      maxPolarAngle={Math.PI / 2.1}
      enableDamping
    />
  ) : null;
}

export default function App() {
  console.log("rendering");
  const [spherePosition, setSpherePosition] = useState(
    new THREE.Vector3(0, 1.0, 0)
  );
  const [cameraMode, setCameraMode] = useState("orbit"); // 'orbit' or 'third-person'
  const groundRef = useRef();

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.code === "KeyC") {
        setCameraMode((prev) => (prev === "orbit" ? "third-person" : "orbit"));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <Canvas camera={{ position: [0, 6, 25], fov: 60 }}>
        <color attach="background" args={["#c2e2ff"]} />
        <ambientLight intensity={0.2} />
        <directionalLight position={[10, 10, 5]} intensity={1} />
        <pointLight position={[0, 8, 0]} intensity={0.8} color="#ffffff" />

        <Ground ref={groundRef} />
        <Grass spherePosition={spherePosition} />
        <KineticSphere
          onPositionChange={setSpherePosition}
          groundRef={groundRef}
        />

        <CameraController
          spherePosition={spherePosition}
          cameraMode={cameraMode}
        />
      </Canvas>
      <div
        style={{
          position: "absolute",
          top: 20,
          left: 20,
          color: "white",
          background: "rgba(0,0,0,0.5)",
          padding: "10px",
          borderRadius: "5px",
          fontFamily: "monospace",
        }}
      >
        150,000 grass blades
        <br />
        Field size: 50x50 units
        <br />
        Camera: {cameraMode}
        <br />
        Controls: WASD to move, C to toggle camera
      </div>
    </div>
  );
}
