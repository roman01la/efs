import * as THREE from 'https://esm.sh/three@0.170.0';
import { OrbitControls } from 'https://esm.sh/three@0.170.0/addons/controls/OrbitControls.js';

const JET_STOPS = [
  [0.0, 0x0000cc],
  [0.25, 0x00cccc],
  [0.5, 0x00cc00],
  [0.75, 0xcccc00],
  [1.0, 0xcc0000],
];

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

const jetColor = (t) => {
  const v = Math.max(0, Math.min(1, t));
  for (let i = 0; i < JET_STOPS.length - 1; i++) {
    const [t0, c0] = JET_STOPS[i];
    const [t1, c1] = JET_STOPS[i + 1];
    if (v <= t1) {
      const f = (v - t0) / (t1 - t0);
      _c1.set(c0);
      _c2.set(c1);
      return _c1.lerp(_c2, f);
    }
  }
  return _c1.set(JET_STOPS[JET_STOPS.length - 1][1]);
};

const buildColorBar = (container, minVal, maxVal) => {
  let bar = container.querySelector('.radiation-colorbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'radiation-colorbar';
    Object.assign(bar.style, {
      position: 'absolute', right: '12px', top: '12px', bottom: '12px',
      width: '20px', display: 'flex', flexDirection: 'column',
      fontFamily: 'Inter, sans-serif', fontSize: '10px', color: '#8888a0',
      pointerEvents: 'none',
    });
    container.appendChild(bar);
  }
  const nTicks = 6;
  const gradColors = [];
  for (let i = 0; i <= 16; i++) {
    const t = 1 - i / 16;
    const c = jetColor(t);
    gradColors.push(c.getStyle());
  }
  bar.innerHTML = '';

  const strip = document.createElement('div');
  Object.assign(strip.style, {
    flex: '1', width: '12px', borderRadius: '2px',
    background: `linear-gradient(to bottom, ${gradColors.join(', ')})`,
  });
  bar.appendChild(strip);

  const labels = document.createElement('div');
  Object.assign(labels.style, {
    position: 'absolute', right: '18px', top: '0', bottom: '0',
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    alignItems: 'flex-end', paddingBlock: '0',
  });
  for (let i = 0; i < nTicks; i++) {
    const t = 1 - i / (nTicks - 1);
    const val = minVal + t * (maxVal - minVal);
    const label = document.createElement('div');
    label.textContent = val.toFixed(1);
    labels.appendChild(label);
  }
  bar.appendChild(labels);

  const unit = document.createElement('div');
  unit.textContent = 'dBi';
  Object.assign(unit.style, { textAlign: 'center', marginTop: '4px', fontSize: '9px' });
  bar.appendChild(unit);
};

export function createRadiationViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x16161c);

  const camera = new THREE.PerspectiveCamera(
    50, container.clientWidth / container.clientHeight, 0.01, 100,
  );
  camera.position.set(1.8, 1.2, 1.8);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const refGeo = new THREE.SphereGeometry(1, 32, 24);
  const refMat = new THREE.MeshBasicMaterial({ color: 0x2a2a35, wireframe: true });
  scene.add(new THREE.Mesh(refGeo, refMat));
  scene.add(new THREE.AxesHelper(0.3));

  let patternMesh = null;
  let animId = null;

  const animate = () => {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  ro.observe(container);

  return {
    update(data) {
      const { thetaRad, phiRad, directivity_dBi, Dmax_dBi } = data;
      const nTheta = thetaRad.length;
      const nPhi = phiRad.length;
      const minClamp = Dmax_dBi - 30;

      if (patternMesh) {
        scene.remove(patternMesh);
        patternMesh.geometry.dispose();
        patternMesh.material.dispose();
        patternMesh = null;
      }

      const positions = new Float32Array(nTheta * nPhi * 3);
      const colors = new Float32Array(nTheta * nPhi * 3);
      const range = Dmax_dBi - minClamp;

      for (let ti = 0; ti < nTheta; ti++) {
        const theta = thetaRad[ti];
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);
        for (let pi = 0; pi < nPhi; pi++) {
          const idx = ti * nPhi + pi;
          const dBi = directivity_dBi[idx];
          const r = Math.max(0.05, (dBi - minClamp) / range);
          const phi = phiRad[pi];
          const off = idx * 3;
          positions[off] = r * sinT * Math.cos(phi);
          positions[off + 1] = r * cosT;
          positions[off + 2] = r * sinT * Math.sin(phi);
          const t = Math.max(0, Math.min(1, (dBi - minClamp) / range));
          const c = jetColor(t);
          colors[off] = c.r;
          colors[off + 1] = c.g;
          colors[off + 2] = c.b;
        }
      }

      const indices = [];
      const phiWraps = Math.abs(phiRad[nPhi - 1] - phiRad[0] - 2 * Math.PI) < 0.01;
      const phiEnd = phiWraps ? nPhi - 1 : nPhi;
      for (let ti = 0; ti < nTheta - 1; ti++) {
        for (let pi = 0; pi < phiEnd - 1; pi++) {
          const a = ti * nPhi + pi;
          const b = a + nPhi;
          const c = a + 1;
          const d = b + 1;
          indices.push(a, b, c, b, d, c);
        }
        if (phiWraps) {
          const a = ti * nPhi + (phiEnd - 1);
          const b = a + nPhi;
          const c = ti * nPhi;
          const d = c + nPhi;
          indices.push(a, b, c, b, d, c);
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();

      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      patternMesh = new THREE.Mesh(geo, mat);
      scene.add(patternMesh);

      buildColorBar(container, minClamp, Dmax_dBi);
    },

    dispose() {
      if (animId != null) cancelAnimationFrame(animId);
      ro.disconnect();
      controls.dispose();
      if (patternMesh) {
        patternMesh.geometry.dispose();
        patternMesh.material.dispose();
      }
      refGeo.dispose();
      refMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      const bar = container.querySelector('.radiation-colorbar');
      if (bar) bar.remove();
    },
  };
}
