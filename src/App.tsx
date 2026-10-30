import React, { useRef, useState, useEffect, useMemo } from "react";
import { Canvas, extend, useFrame, useThree, type Catalogue } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three/webgpu";
import { mix, normalWorldGeometry, output, smoothstep, vec4 } from "three/tsl";
import { useControls } from "leva";
import WebGPUGrass, { type GrassLook } from "./WebGPUGrass";

// Make R3F intrinsic elements resolve to the WebGPU build of three
extend(THREE as unknown as Catalogue);

type ScenePreset = {
  background: string;
  fog?: { color: string; near: number; far: number };
  ambient: { color: string; intensity: number };
  light: {
    position: [number, number, number];
    color: string;
    intensity: number;
  };
  moon?: { position: [number, number, number]; radius: number; color: string };
  grass: GrassLook;
};

const SCENES: Record<string, ScenePreset> = {
  Day: {
    background: "#c2e2ff",
    ambient: { color: "#ffffff", intensity: 0.4 },
    light: { position: [10, 10, 5], color: "#FFFFCC", intensity: 1 },
    grass: { specular: "#55554a", shininess: 30, tipTint: [1.0, 0.9, 0.6], translucency: 0.35 },
  },
  Moon: {
    background: "#070b16",
    fog: { color: "#070b16", near: 60, far: 150 },
    ambient: { color: "#7086cc", intensity: 1.4 },
    // Same general direction as the Day sun
    light: { position: [45, 50, 22], color: "#b4d6c4", intensity: 1.6 },
    moon: { position: [225, 250, 110], radius: 9, color: "#eef2ff" },
    grass: { specular: "#90a89a", shininess: 24, tipTint: [0.75, 0.85, 1.0], translucency: 0 },
  },
};

function SceneLighting({ preset }: { preset: ScenePreset }) {
  return (
    <>
      <color attach="background" args={[preset.background]} />
      {preset.fog && (
        <fog
          attach="fog"
          args={[preset.fog.color, preset.fog.near, preset.fog.far]}
        />
      )}
      <ambientLight
        color={preset.ambient.color}
        intensity={preset.ambient.intensity}
      />
      <directionalLight
        position={preset.light.position}
        color={preset.light.color}
        intensity={preset.light.intensity}
      />
      {preset.moon && (
        <mesh position={preset.moon.position}>
          <sphereGeometry args={[preset.moon.radius, 32, 16]} />
          <meshBasicMaterial color={preset.moon.color} fog={false} />
        </mesh>
      )}
    </>
  );
}

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

  const material = useMemo(() => {
    const mat = new THREE.MeshStandardNodeMaterial({
      roughness: 0.3,
      metalness: 0.1,
      color: "#F44",
    });
    // Fake ambient occlusion - darken the underside of the ball
    const bottomFactor = smoothstep(-0.5, 0.2, normalWorldGeometry.y);
    mat.outputNode = vec4(output.rgb.mul(mix(0.3, 1.0, bottomFactor)), output.a);
    return mat;
  }, []);
  useEffect(() => () => material.dispose(), [material]);
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
      <primitive object={material} attach="material" />
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
  const { Scene: sceneName } = useControls("Controls", {
    "Controls": {
      value: "WASD/Mouse: Move ball, C: Toggle camera",
      editable: false
    },
    Scene: { value: "Day", options: Object.keys(SCENES) },
  });
  const scene = SCENES[sceneName];

  // Get fieldSize from Grass component's Leva controls
  const { "Field Size": fieldSize } = useControls("🌿 Grass Field", {
    "Blade Count": { value: 80_000, min: 1000, max: 500_000, step: 10_000 },
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
        gl={async ({ canvas }) => {
          const renderer = new THREE.WebGPURenderer({
            canvas: canvas as HTMLCanvasElement,
            antialias: true,
            alpha: false,
            powerPreference: "high-performance",
          });
          await renderer.init();
          return renderer;
        }}
      >
        <SceneLighting key={sceneName} preset={scene} />

        <Ground ref={groundRef} fieldSize={fieldSize} />
        <WebGPUGrass spherePosition={spherePosition} look={scene.grass} sunPosition={scene.light.position} />
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
