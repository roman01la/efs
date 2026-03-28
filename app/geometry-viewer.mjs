import * as THREE from 'https://esm.sh/three@0.170.0';
import { OrbitControls } from 'https://esm.sh/three@0.170.0/addons/controls/OrbitControls.js';

const PROPERTY_COLORS = {
  Metal:           { color: 0xC0C0C0, opacity: 1.0, wireframe: false },
  ConductingSheet: { color: 0xB87333, opacity: 1.0, wireframe: false },
  LumpedElement:   { color: 0xFF8800, opacity: 1.0, wireframe: false },
  Excitation:      { color: 0xFF2222, opacity: 1.0, wireframe: false },
  Material:        { color: 0x4488FF, opacity: 0.4, wireframe: false },
  ProbeBox:        { color: 0x22CC22, opacity: 1.0, wireframe: true },
  DumpBox:         { color: 0xCCCC22, opacity: 1.0, wireframe: true },
};

function makeMaterial(type) {
  const cfg = PROPERTY_COLORS[type] || PROPERTY_COLORS.Metal;
  if (cfg.wireframe) {
    return new THREE.MeshBasicMaterial({ color: cfg.color, wireframe: true });
  }
  const mat = new THREE.MeshStandardMaterial({
    color: cfg.color,
    opacity: cfg.opacity,
    transparent: cfg.opacity < 1,
    side: THREE.DoubleSide,
  });
  return mat;
}

function parseFloatAttr(el, attr) {
  return parseFloat(el.getAttribute(attr)) || 0;
}

function parsePoint(el) {
  return new THREE.Vector3(
    parseFloatAttr(el, 'X'),
    parseFloatAttr(el, 'Y'),
    parseFloatAttr(el, 'Z'),
  );
}

function parseCSV(text) {
  return text.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
}

function buildBox(el, scale, material) {
  const p1 = parsePoint(el.querySelector('P1')).multiplyScalar(scale);
  const p2 = parsePoint(el.querySelector('P2')).multiplyScalar(scale);
  const min = new THREE.Vector3().min(p1).min(p2);
  const max = new THREE.Vector3().max(p1).max(p2);
  // Correct min/max
  min.set(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.min(p1.z, p2.z));
  max.set(Math.max(p1.x, p2.x), Math.max(p1.y, p2.y), Math.max(p1.z, p2.z));

  let sx = max.x - min.x;
  let sy = max.y - min.y;
  let sz = max.z - min.z;
  const thin = 0.2 * scale;
  if (sx === 0) sx = thin;
  if (sy === 0) sy = thin;
  if (sz === 0) sz = thin;

  const geo = new THREE.BoxGeometry(sx, sy, sz);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(
    min.x + (max.x - min.x) / 2,
    min.y + (max.y - min.y) / 2,
    min.z + (max.z - min.z) / 2,
  );
  return mesh;
}

function buildCylinder(el, scale, material) {
  const p1 = parsePoint(el.querySelector('P1')).multiplyScalar(scale);
  const p2 = parsePoint(el.querySelector('P2')).multiplyScalar(scale);
  const radius = parseFloat(el.getAttribute('Radius') || '1') * scale;
  const axis = new THREE.Vector3().subVectors(p2, p1);
  const height = axis.length() || 0.2 * scale;
  const geo = new THREE.CylinderGeometry(radius, radius, height, 24);
  const mesh = new THREE.Mesh(geo, material);
  const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
  mesh.position.copy(mid);
  if (axis.lengthSq() > 0) {
    const dir = axis.clone().normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
    mesh.quaternion.copy(quat);
  }
  return mesh;
}

function buildSphere(el, scale, material) {
  const center = parsePoint(el.querySelector('Center') || el.querySelector('P1')).multiplyScalar(scale);
  const radius = parseFloat(el.getAttribute('Radius') || '1') * scale;
  const geo = new THREE.SphereGeometry(radius, 24, 16);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.copy(center);
  return mesh;
}

function getVertices(el) {
  const pts = el.querySelectorAll('Vertex');
  return pts.length > 0 ? [...pts] : [...el.querySelectorAll('Point')];
}

function buildCurve(el, scale, material) {
  const points = getVertices(el).map(p => parsePoint(p).multiplyScalar(scale));
  if (points.length < 2) return null;
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: material.color }));
}

function buildWire(el, scale, material) {
  const points = getVertices(el).map(p => parsePoint(p).multiplyScalar(scale));
  if (points.length < 2) return null;
  const radius = parseFloat(el.getAttribute('WireRadius') || el.getAttribute('Radius') || '0.5') * scale;
  const curve = new THREE.CatmullRomCurve3(points, false);
  const geo = new THREE.TubeGeometry(curve, points.length * 8, radius, 8, false);
  return new THREE.Mesh(geo, material);
}

function buildLinPoly(el, scale, material) {
  const points = [...el.querySelectorAll('Point')].map(p => parsePoint(p).multiplyScalar(scale));
  if (points.length < 3) return null;
  const normDir = parseInt(el.getAttribute('NormDir') || '2');
  const elevation = parseFloat(el.getAttribute('Elevation') || '0') * scale;
  const length = parseFloat(el.getAttribute('Length') || '0') * scale;

  const axes = [[1, 2, 0], [0, 2, 1], [0, 1, 2]][normDir] || [0, 1, 2];
  const shape = new THREE.Shape();
  const comps = ['x', 'y', 'z'];
  const u = comps[axes[0]], v = comps[axes[1]];

  points.forEach((p, i) => {
    if (i === 0) shape.moveTo(p[u], p[v]);
    else shape.lineTo(p[u], p[v]);
  });
  shape.closePath();

  const extrudeLen = Math.abs(length) || 0.2 * scale;
  const geo = new THREE.ExtrudeGeometry(shape, { depth: extrudeLen, bevelEnabled: false });
  const mesh = new THREE.Mesh(geo, material);
  const n = comps[axes[2]];
  if (n === 'x') mesh.rotation.set(0, Math.PI / 2, 0);
  else if (n === 'y') mesh.rotation.set(-Math.PI / 2, 0, 0);
  mesh.position[n] = elevation;
  return mesh;
}

const PRIMITIVE_BUILDERS = {
  Box: buildBox,
  Cylinder: buildCylinder,
  Sphere: buildSphere,
  Curve: buildCurve,
  Wire: buildWire,
  LinPoly: buildLinPoly,
};

function parseGrid(csEl, scale) {
  const gridEl = csEl.querySelector('RectilinearGrid');
  if (!gridEl) return null;
  const xLines = parseCSV(gridEl.querySelector('XLines')?.textContent || '').map(v => v * scale);
  const yLines = parseCSV(gridEl.querySelector('YLines')?.textContent || '').map(v => v * scale);
  const zLines = parseCSV(gridEl.querySelector('ZLines')?.textContent || '').map(v => v * scale);
  return { xLines, yLines, zLines };
}

function buildGridLines(grid) {
  const { xLines, yLines, zLines } = grid;
  if (!xLines.length || !yLines.length || !zLines.length) return null;

  const xMin = xLines[0], xMax = xLines[xLines.length - 1];
  const yMin = yLines[0], yMax = yLines[yLines.length - 1];
  const zMin = zLines[0], zMax = zLines[zLines.length - 1];

  const points = [];
  const addLine = (a, b) => { points.push(a.x, a.y, a.z, b.x, b.y, b.z); };

  // XY faces (zMin, zMax)
  for (const z of [zMin, zMax]) {
    for (const x of xLines) addLine(new THREE.Vector3(x, yMin, z), new THREE.Vector3(x, yMax, z));
    for (const y of yLines) addLine(new THREE.Vector3(xMin, y, z), new THREE.Vector3(xMax, y, z));
  }
  // XZ faces (yMin, yMax)
  for (const y of [yMin, yMax]) {
    for (const x of xLines) addLine(new THREE.Vector3(x, y, zMin), new THREE.Vector3(x, y, zMax));
    for (const z of zLines) addLine(new THREE.Vector3(xMin, y, z), new THREE.Vector3(xMax, y, z));
  }
  // YZ faces (xMin, xMax)
  for (const x of [xMin, xMax]) {
    for (const y of yLines) addLine(new THREE.Vector3(x, y, zMin), new THREE.Vector3(x, y, zMax));
    for (const z of zLines) addLine(new THREE.Vector3(x, yMin, z), new THREE.Vector3(x, yMax, z));
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x2a2a35 });
  return new THREE.LineSegments(geo, mat);
}

function fitCamera(camera, controls, bbox) {
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fov = camera.fov * (Math.PI / 180);
  const dist = maxDim / (2 * Math.tan(fov / 2)) * 1.5;

  camera.position.set(center.x + dist * 0.6, center.y + dist * 0.4, center.z + dist * 0.8);
  camera.near = dist * 0.01;
  camera.far = dist * 10;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

export function buildMeshesFromXML(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const cs = doc.querySelector('ContinuousStructure');
  if (!cs) return [];
  const gridEl = cs.querySelector('RectilinearGrid');
  const deltaUnit = parseFloat(gridEl?.getAttribute('DeltaUnit') || '1');
  const meshes = [];
  const propsEl = cs.querySelector('Properties');
  if (propsEl) {
    for (const propEl of propsEl.children) {
      const propType = propEl.tagName;
      if (propType === 'DumpBox' || propType === 'ProbeBox') continue;
      const material = makeMaterial(propType);
      const primsEl = propEl.querySelector('Primitives');
      if (!primsEl) continue;
      for (const primEl of primsEl.children) {
        const builder = PRIMITIVE_BUILDERS[primEl.tagName];
        if (!builder) continue;
        const obj = builder(primEl, deltaUnit, material);
        if (obj) meshes.push(obj);
      }
    }
  }
  return meshes;
}

export function createViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x16161c);

  const camera = new THREE.PerspectiveCamera(
    50,
    container.clientWidth / container.clientHeight,
    0.1,
    1000,
  );
  camera.position.set(5, 5, 5);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(1, 2, 1.5);
  scene.add(ambientLight, dirLight);

  let axesHelper = null;
  let gridLinesMesh = null;
  const userMeshes = [];

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

  let _showGrid = true;

  const viewer = {
    get showGrid() { return _showGrid; },
    set showGrid(v) {
      _showGrid = v;
      if (gridLinesMesh) gridLinesMesh.visible = v;
    },

    update(xml) {
      // Clear previous geometry
      for (const obj of userMeshes) {
        scene.remove(obj);
        obj.traverse?.(child => {
          child.geometry?.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
            else child.material.dispose();
          }
        });
      }
      userMeshes.length = 0;
      if (axesHelper) { scene.remove(axesHelper); axesHelper = null; }
      if (gridLinesMesh) { scene.remove(gridLinesMesh); gridLinesMesh = null; }

      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const cs = doc.querySelector('ContinuousStructure');
      if (!cs) return;

      const gridEl = cs.querySelector('RectilinearGrid');
      const deltaUnit = parseFloat(gridEl?.getAttribute('DeltaUnit') || '1');

      const bbox = new THREE.Box3();

      // Parse properties and their primitives
      const propsEl = cs.querySelector('Properties');
      if (propsEl) {
        for (const propEl of propsEl.children) {
          const propType = propEl.tagName;
          const material = makeMaterial(propType);
          const primsEl = propEl.querySelector('Primitives');
          if (!primsEl) continue;

          for (const primEl of primsEl.children) {
            const builder = PRIMITIVE_BUILDERS[primEl.tagName];
            if (!builder) continue;
            const obj = builder(primEl, deltaUnit, material);
            if (!obj) continue;
            scene.add(obj);
            userMeshes.push(obj);
            const b = new THREE.Box3().setFromObject(obj);
            bbox.union(b);
          }
        }
      }

      // Grid lines
      const grid = parseGrid(cs, deltaUnit);
      if (grid) {
        gridLinesMesh = buildGridLines(grid);
        if (gridLinesMesh) {
          gridLinesMesh.visible = _showGrid;
          scene.add(gridLinesMesh);
          userMeshes.push(gridLinesMesh);
          bbox.union(new THREE.Box3().setFromObject(gridLinesMesh));
        }
      }

      // Axes helper
      if (!bbox.isEmpty()) {
        const size = new THREE.Vector3();
        bbox.getSize(size);
        const extent = Math.max(size.x, size.y, size.z);
        axesHelper = new THREE.AxesHelper(extent * 0.2);
        scene.add(axesHelper);
        fitCamera(camera, controls, bbox);
      }
    },

    dispose() {
      if (animId != null) cancelAnimationFrame(animId);
      ro.disconnect();
      controls.dispose();

      for (const obj of userMeshes) {
        obj.traverse?.(child => {
          child.geometry?.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
            else child.material.dispose();
          }
        });
      }
      userMeshes.length = 0;

      renderer.dispose();
      renderer.domElement.remove();
    },
  };

  return viewer;
}
