import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Color, type IUniform, type Mesh, type ShaderMaterial } from "three";

function hexToNormalizedRGB(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  ];
}

const vertexShader = `
varying vec2 vUv;
varying vec3 vPosition;

void main() {
  vPosition = position;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
varying vec2 vUv;
varying vec3 vPosition;

uniform float uTime;
uniform vec3  uColor;
uniform float uSpeed;
uniform float uScale;
uniform float uRotation;
uniform float uNoiseIntensity;

const float e = 2.71828182845904523536;

float noise(vec2 texCoord) {
  float G = e;
  vec2  r = (G * sin(G * texCoord));
  return fract(r.x * r.y * (1.0 + texCoord.x));
}

vec2 rotateUvs(vec2 uv, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  mat2  rot = mat2(c, -s, s, c);
  return rot * uv;
}

void main() {
  float rnd        = noise(gl_FragCoord.xy);
  vec2  uv         = rotateUvs(vUv * uScale, uRotation);
  vec2  tex        = uv * uScale;
  float tOffset    = uSpeed * uTime;

  tex.y += 0.03 * sin(8.0 * tex.x - tOffset);

  float pattern = 0.6 +
                  0.4 * sin(5.0 * (tex.x + tex.y +
                                   cos(3.0 * tex.x + 5.0 * tex.y) +
                                   0.02 * tOffset) +
                           sin(20.0 * (tex.x + tex.y - 0.1 * tOffset)));

  float grain = rnd / 15.0 * uNoiseIntensity;
  vec3 result = uColor * pattern - vec3(grain);
  gl_FragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}
`;

type SilkUniforms = {
  uSpeed: IUniform<number>;
  uScale: IUniform<number>;
  uNoiseIntensity: IUniform<number>;
  uColor: IUniform<Color>;
  uRotation: IUniform<number>;
  uTime: IUniform<number>;
};

const SilkPlane = forwardRef<Mesh, { uniforms: SilkUniforms }>(function SilkPlane(
  { uniforms },
  ref
) {
  const { viewport } = useThree();
  const meshRef = ref as React.MutableRefObject<Mesh | null>;

  useLayoutEffect(() => {
    if (meshRef.current) {
      meshRef.current.scale.set(viewport.width, viewport.height, 1);
    }
  }, [meshRef, viewport]);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const material = mesh.material as ShaderMaterial;
    const uTime = material.uniforms.uTime;
    if (uTime) uTime.value += 0.1 * delta;
  });

  return (
    <mesh ref={ref}>
      <planeGeometry args={[1, 1, 1, 1]} />
      <shaderMaterial uniforms={uniforms} vertexShader={vertexShader} fragmentShader={fragmentShader} />
    </mesh>
  );
});

export interface SilkProps {
  speed?: number;
  scale?: number;
  color?: string;
  noiseIntensity?: number;
  rotation?: number;
}

export default function Silk({
  speed = 5,
  scale = 1,
  color = "#7B7481",
  noiseIntensity = 1.5,
  rotation = 0
}: SilkProps) {
  const meshRef = useRef<Mesh>(null);

  const uniforms = useMemo<SilkUniforms>(
    () => ({
      uSpeed: { value: speed },
      uScale: { value: scale },
      uNoiseIntensity: { value: noiseIntensity },
      uColor: { value: new Color(...hexToNormalizedRGB(color)) },
      uRotation: { value: rotation },
      uTime: { value: 0 }
    }),
    // Uniform objects are mutated in place below; recreating them would reset uTime.
    []
  );

  useEffect(() => {
    uniforms.uSpeed.value = speed;
    uniforms.uScale.value = scale;
    uniforms.uNoiseIntensity.value = noiseIntensity;
    uniforms.uColor.value.setRGB(...hexToNormalizedRGB(color));
    uniforms.uRotation.value = rotation;
  }, [speed, scale, noiseIntensity, color, rotation, uniforms]);

  return (
    <Canvas dpr={[1, 2]} frameloop="always">
      <SilkPlane ref={meshRef} uniforms={uniforms} />
    </Canvas>
  );
}
