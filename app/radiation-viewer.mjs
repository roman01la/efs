import * as THREE from 'https://esm.sh/three@0.170.0';
import { OrbitControls } from 'https://esm.sh/three@0.170.0/addons/controls/OrbitControls.js';
import { buildMeshesFromXML } from '/app/geometry-viewer.mjs';

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
  let antennaGroup = null;
  let showAntenna = false;
  let animId = null;

  // Lighting for antenna geometry (only visible when antenna is shown)
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
  dirLight.position.set(1, 2, 1.5);
  scene.add(ambientLight, dirLight);

  // Toggle button
  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = 'Show Antenna';
  Object.assign(toggleBtn.style, {
    position: 'absolute', left: '12px', top: '12px', zIndex: '10',
    padding: '4px 10px', fontSize: '10px', fontFamily: 'Inter, sans-serif',
    fontWeight: '500', border: '1px solid #2a2a35', borderRadius: '4px',
    background: '#1e1e26', color: '#8888a0', cursor: 'pointer',
  });
  toggleBtn.addEventListener('click', () => {
    showAntenna = !showAntenna;
    toggleBtn.textContent = showAntenna ? 'Hide Antenna' : 'Show Antenna';
    toggleBtn.style.borderColor = showAntenna ? '#6366f1' : '#2a2a35';
    toggleBtn.style.color = showAntenna ? '#c7d2fe' : '#8888a0';
    if (antennaGroup) antennaGroup.visible = showAntenna;
    if (patternMesh) {
      patternMesh.material.transparent = showAntenna;
      patternMesh.material.opacity = showAntenna ? 0.55 : 1;
      patternMesh.material.depthWrite = !showAntenna;
      patternMesh.material.needsUpdate = true;
    }
  });
  container.appendChild(toggleBtn);

  const animate = () => {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  const ro = new ResizeObserver((entries) => {
    const { width: w, height: h } = entries[0].contentRect;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  ro.observe(container);

  return {
    update(data) {
      const { thetaRad, phiRad, directivity_dBi, Dmax_dBi, xml } = data;
      const nTheta = thetaRad.length;
      const nPhi = phiRad.length;
      const minClamp = Dmax_dBi - 30;

      if (patternMesh) {
        scene.remove(patternMesh);
        patternMesh.geometry.dispose();
        patternMesh.material.dispose();
        patternMesh = null;
      }

      // Build antenna geometry
      if (antennaGroup) {
        antennaGroup.traverse(child => {
          child.geometry?.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
            else child.material.dispose();
          }
        });
        scene.remove(antennaGroup);
        antennaGroup = null;
      }
      if (xml) {
        const meshes = buildMeshesFromXML(xml);
        if (meshes.length > 0) {
          // Geometry stays at FDTD origin (0,0,0) — the NF2FF integration center
          const inner = new THREE.Group();
          const bbox = new THREE.Box3();
          for (const m of meshes) {
            inner.add(m);
            bbox.union(new THREE.Box3().setFromObject(m));
          }
          const size = new THREE.Vector3();
          bbox.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z) || 1;

          // Scale to fit inside pattern, rotate Z-up → Y-up
          antennaGroup = new THREE.Group();
          antennaGroup.add(inner);
          antennaGroup.scale.setScalar(0.4 / maxDim);
          antennaGroup.rotation.x = -Math.PI / 2;
          antennaGroup.visible = showAntenna;
          scene.add(antennaGroup);
        }
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
      if (antennaGroup) {
        antennaGroup.traverse(child => {
          child.geometry?.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
            else child.material.dispose();
          }
        });
      }
      refGeo.dispose();
      refMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      toggleBtn.remove();
      const bar = container.querySelector('.radiation-colorbar');
      if (bar) bar.remove();
    },
  };
}
