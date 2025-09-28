import React, { useRef, useState, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { useControls } from "leva";
import WebGLGrass from "./WebGLGrass";

const Ground = React.forwardRef(({ fieldSize = 50 }, ref) => {
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
      <planeGeometry args={[fieldSize, fieldSize]} key={fieldSize} />
      <meshStandardMaterial color="#232712" />
    </mesh>
  );
});

function KineticSphere({ onPositionChange, groundRef }) {
  const meshRef = useRef<THREE.Mesh>(null);
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

    const handleMouseDown = () => {
      isMousePressed.current = true;
    };

    const handleMouseUp = () => {
      isMousePressed.current = false;
      mouseTarget.current = null;
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("touchstart", handleMouseDown);
    window.addEventListener("touchend", handleMouseUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("touchstart", handleMouseDown);
      window.removeEventListener("touchend", handleMouseUp);
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
      <meshStandardMaterial roughness={0.3} metalness={0.1} color="#F44" />
    </mesh>
  );
}

function CameraController({ spherePosition, cameraMode }) {
  const { camera } = useThree();
  const orbitRef = useRef();

  useFrame(() => {
    if (cameraMode === "third-person" && spherePosition) {
      // Change FOV for third-person mode
      camera.fov = 70;
      camera.updateProjectionMatrix();

      // Third-person camera follows sphere - closer to ground
      const offset = new THREE.Vector3(0, 2.5, 6);
      const targetPosition = spherePosition.clone().add(offset);

      camera.position.lerp(targetPosition, 0.1);
      camera.lookAt(spherePosition.x, spherePosition.y, spherePosition.z);
    } else if (cameraMode === "orbit") {
      // Reset FOV for orbit mode
      camera.fov = 20;
      camera.updateProjectionMatrix();
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
  const [spherePosition, setSpherePosition] = useState(
    new THREE.Vector3(0, 1.0, 0)
  );
  const [cameraMode, setCameraMode] = useState("orbit"); // 'orbit' or 'third-person'
  const groundRef = useRef();

  

  // Project description in Leva
  useControls("Controls", {
    "Controls": {
      value: "WASD/Mouse: Move ball, C: Toggle camera",
      editable: false
    }
  });

  // Get fieldSize from Grass component's Leva controls
  const { "Field Size": fieldSize, "Wind Speed": windSpeed, "Blade Height": grassHeight } = useControls("🌿 Grass Field", {
    "Blade Count": { value: 100_000, min: 1000, max: 500_000, step: 10_000 },
    "Blade Height": { value: 1.3, min: 0.7, max: 4.0, step: 0.1 },
    "Field Size": { value: 50, min: 10, max: 200, step: 5 },
    "Wind Speed": { value: 1.0, min: 0.0, max: 2.0, step: 0.1 },
  });


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
      <Canvas
        camera={{ position: [55, 30, 55], fov: 20 }}
        style={{
          userSelect: "none",
          WebkitUserSelect: "none",
          touchAction: "none"
        }}
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: "high-performance",
        }}
      >
        <color attach="background" args={["#c2e2ff"]} />
        <ambientLight intensity={0.2} />
        <directionalLight position={[10, 10, 5]} intensity={1} />
        <pointLight position={[0, 8, 0]} intensity={0.8} color="#ffffff" />

        <Ground ref={groundRef} fieldSize={fieldSize} />
        <WebGLGrass spherePosition={spherePosition} windSpeed={windSpeed} grassHeight={grassHeight} />
        <KineticSphere
          onPositionChange={setSpherePosition}
          groundRef={groundRef}
        />

        <CameraController
          spherePosition={spherePosition}
          cameraMode={cameraMode}
        />
      </Canvas>
    </div>
  );
}
