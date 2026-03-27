/**
 * Example scripts for the demo examples.
 *
 * Each export is an object with { name, script } where script is a JS string
 * executed via `new Function('OpenEMS', 'ContinuousStructure', code)`.
 * The script must end with `return FDTD.GenerateXML();`.
 */

/**
 * Patch Antenna example.
 *
 * 32.86 x 41.37 mm patch on FR4 substrate (epsilon_r = 3.38, 1.524 mm thick).
 * 60 x 60 mm ground plane. Lumped port feed at x = -5.5 mm, 50 Ohm.
 * Gaussian excitation 0-6 GHz, 30000 timesteps, end criteria 1e-5.
 */
export const PATCH_ANTENNA = {
  name: 'Patch Antenna',
  script: `
// Patch Antenna — parametric design
const unit = 1e-3; // all lengths in mm
const f0 = 3e9;    // center frequency
const fc = 3e9;    // 20dB corner frequency

// substrate
const epsR = 3.38;
const subW = 60, subL = 60, subH = 1.524;

// patch dimensions
const patchW = 32.86, patchL = 41.37;

// feed position
const feedX = -5.5;
const feedR = 50; // ohm
const feedH = subH;

// PML padding
const pmlPad = 15;

// NF2FF box inset from PML
const nf2ffDist = 10;

// derived
const halfSubW = subW / 2;
const halfSubL = subL / 2;
const halfPatchW = patchW / 2;
const halfPatchL = patchL / 2;
const simXmax = halfSubW + pmlPad;
const simYmax = halfSubL + pmlPad;
const simZmin = -10;
const simZmax = 20;
const nfX = halfSubW + nf2ffDist / 2;
const nfY = halfSubL + nf2ffDist / 2;
const nfZmin = -6;
const nfZmax = 15;

// setup FDTD
const FDTD = new OpenEMS({ NrTS: 30000, EndCriteria: 1e-5 });
FDTD.SetGaussExcite(f0, fc);
FDTD.SetBoundaryCond(['PML_8','PML_8','PML_8','PML_8','PML_8','PML_8']);

const CSX = new ContinuousStructure();
FDTD.SetCSX(CSX);

const mesh = CSX.GetGrid();
mesh.SetDeltaUnit(unit);

// mesh — x
mesh.AddLine('x', [-simXmax, -halfSubW, -halfPatchW, feedX - 1, feedX, feedX + 1, 0, halfPatchW, halfSubW, simXmax]);
mesh.SmoothMeshLines('x', 4, 1.4);

// mesh — y
mesh.AddLine('y', [-simYmax, -halfSubL, -halfPatchL, 0, halfPatchL, halfSubL, simYmax]);
mesh.SmoothMeshLines('y', 4, 1.4);

// mesh — z
mesh.AddLine('z', [simZmin, 0, subH * 0.2, subH / 2, subH, subH + 1, 6, 10, simZmax]);
mesh.SmoothMeshLines('z', 4, 1.4);

// ground plane
const ground = CSX.AddMetal('ground');
ground.AddBox([-halfSubW, -halfSubL, 0], [halfSubW, halfSubL, 0], 10);

// substrate
const substrate = CSX.AddMaterial('substrate', { Epsilon: epsR });
substrate.AddBox([-halfSubW, -halfSubL, 0], [halfSubW, halfSubL, subH], 5);

// patch
const patch = CSX.AddMetal('patch');
patch.AddBox([-halfPatchW, -halfPatchL, subH], [halfPatchW, halfPatchL, subH], 10);

// lumped port feed
FDTD.AddLumpedPort(1, feedR, [feedX, 0, 0], [feedX, 0, feedH], 'z', 1.0);

// NF2FF box
FDTD.CreateNF2FFBox({ frequency: 2.4e9 });

return FDTD.GenerateXML();
`
};

/**
 * MSL Notch Filter example.
 *
 * Microstrip line with a notch (quarter-wave stub) on FR4 substrate.
 * Two MSL ports for S11/S21 measurement.
 * Gaussian excitation 0-10 GHz.
 */
export const MSL_NOTCH_FILTER = {
  name: 'MSL Notch Filter',
  script: `
// MSL Notch Filter — parametric design
const unit = 1e-3;
const f0 = 5e9;
const fc = 5e9;

// substrate
const epsR = 3.38;
const subW = 40, subL = 30, subH = 1.524;

// MSL trace
const traceW = 3.0; // width of microstrip line
const halfTraceW = traceW / 2;

// notch stub
const stubW = 3.0;
const stubL = 8.5; // quarter-wave stub length
const halfStubW = stubW / 2;

// port positions
const port1X = -18;
const port2X = 18;
const portR = 50;

// PML padding
const pmlPad = 5;

// derived
const halfSubW = subW / 2;
const halfSubL = subL / 2;
const simXmax = halfSubW;
const simYmax = halfSubL;
const simZmin = -5;
const simZmax = 12;

// setup FDTD
const FDTD = new OpenEMS({ NrTS: 20000, EndCriteria: 1e-5 });
FDTD.SetGaussExcite(f0, fc);
FDTD.SetBoundaryCond(['PML_8','PML_8','PML_8','PML_8','PEC','PML_8']);

const CSX = new ContinuousStructure();
FDTD.SetCSX(CSX);

const mesh = CSX.GetGrid();
mesh.SetDeltaUnit(unit);

// mesh — x
mesh.AddLine('x', [-simXmax, port1X - 1, port1X, port1X + 1, -halfStubW, 0, halfStubW, port2X - 1, port2X, port2X + 1, simXmax]);
mesh.SmoothMeshLines('x', 2, 1.4);

// mesh — y
mesh.AddLine('y', [-simYmax, -halfTraceW, 0, halfTraceW, halfTraceW + stubL, simYmax]);
mesh.SmoothMeshLines('y', 2, 1.4);

// mesh — z
mesh.AddLine('z', [simZmin, 0, subH * 0.25, subH / 2, subH, 2, 5, simZmax]);
mesh.SmoothMeshLines('z', 2, 1.4);

// ground plane
const ground = CSX.AddMetal('ground');
ground.AddBox([-simXmax, -simYmax, 0], [simXmax, simYmax, 0], 10);

// substrate
const substrate = CSX.AddMaterial('substrate', { Epsilon: epsR });
substrate.AddBox([-simXmax, -simYmax, 0], [simXmax, simYmax, subH], 5);

// MSL trace
const msl = CSX.AddMetal('msl_trace');
msl.AddBox([-simXmax, -halfTraceW, subH], [simXmax, halfTraceW, subH], 10);

// notch stub
const stub = CSX.AddMetal('notch_stub');
stub.AddBox([-halfStubW, halfTraceW, subH], [halfStubW, halfTraceW + stubL, subH], 10);

// port 1 — excited
FDTD.AddLumpedPort(1, portR, [port1X, 0, 0], [port1X, 0, subH], 'z', 1.0);

// port 2 — passive (no excitation)
FDTD.AddLumpedPort(2, portR, [port2X, 0, 0], [port2X, 0, subH], 'z', 0);

return FDTD.GenerateXML();
`
};

/**
 * Helical Antenna example.
 *
 * Based on https://docs.openems.de/python/openEMS/Tutorials/Helical_Antenna.html
 * 9-turn axial-mode helix at 2.4 GHz. Radius 20 mm, pitch 30 mm.
 * Circular ground plane (r = 62.5 mm). Feed impedance 120 Ohm.
 * Gaussian excitation 1.9-2.9 GHz, PML boundaries.
 */
export const HELICAL_ANTENNA = {
  name: 'Helical Antenna',
  script: `
// Helical Antenna — parametric design
const unit = 1e-3;
const f0 = 2.4e9;
const fc = 0.5e9;

// helix parameters
const turns = 9;
const radius = 20;   // mm
const pitch = 30;     // mm per turn
const feedH = 3;      // feed pin height (mm)
const feedR = 120;    // feed impedance (ohm)

// ground plane
const gndRadius = 62.5; // mm

// simulation box
const simXY = 130;
const simZmin = -130;
const simZmax = 400;

// NF2FF box
const nfXY = 90;
const nfZmin = -40;
const nfZmax = 320;

// helix top
const helixTop = feedH + turns * pitch;

// setup FDTD
const FDTD = new OpenEMS({ NrTS: 30000, EndCriteria: 1e-4 });
FDTD.SetGaussExcite(f0, fc);
FDTD.SetBoundaryCond(['PML_8','PML_8','PML_8','PML_8','PML_8','PML_8']);

const CSX = new ContinuousStructure();
FDTD.SetCSX(CSX);

const mesh = CSX.GetGrid();
mesh.SetDeltaUnit(unit);

// mesh — x, y (symmetric)
mesh.AddLine('x', [-simXY, -nfXY, -gndRadius, -radius, 0, radius, gndRadius, nfXY, simXY]);
mesh.SmoothMeshLines('x', 10, 1.4);

mesh.AddLine('y', [-simXY, -nfXY, -gndRadius, -radius, 0, radius, gndRadius, nfXY, simXY]);
mesh.SmoothMeshLines('y', 10, 1.4);

// mesh — z
const zLines = [simZmin, nfZmin, -10, 0, feedH];
for (let i = 0; i <= turns; i++) {
  zLines.push(feedH + i * pitch);
}
zLines.push(helixTop + 20, nfZmax, simZmax);
mesh.AddLine('z', zLines);
mesh.SmoothMeshLines('z', 10, 1.4);

// helix curve — generate programmatically
const helixX = [], helixY = [], helixZ = [];
const ptsPerTurn = 10;
for (let i = 0; i <= turns * ptsPerTurn; i++) {
  const t = i / ptsPerTurn;
  helixX.push(radius * Math.cos(t * 2 * Math.PI));
  helixY.push(radius * Math.sin(t * 2 * Math.PI));
  helixZ.push(feedH + t * pitch);
}
const helix = CSX.AddMetal('helix');
helix.AddCurve([helixX, helixY, helixZ], 5);

// circular ground plane
const gnd = CSX.AddMetal('gnd');
gnd.AddCylinder([0, 0, -0.1], [0, 0, 0.1], gndRadius, 10);

// lumped port feed (from ground to helix start)
FDTD.AddLumpedPort(1, feedR, [radius, 0, 0], [radius, 0, feedH], 'z', 1.0);

// NF2FF box
FDTD.CreateNF2FFBox({ frequency: f0 });

return FDTD.GenerateXML();
`
};

/**
 * Rectangular Waveguide example.
 *
 * WR-90 waveguide (22.86 x 10.16 mm) with TE10 mode excitation.
 * PEC walls, PML termination at both ends.
 * Gaussian excitation covering 8-12 GHz (X-band).
 */
export const RECT_WAVEGUIDE = {
  name: 'Rect Waveguide',
  script: `
// Rectangular Waveguide — parametric design
const unit = 1e-3;
const f0 = 10e9;
const fc = 2e9;

// WR-90 waveguide dimensions
const wgW = 22.86; // broad wall (y)
const wgH = 10.16; // narrow wall (z)
const wgL = 60;    // total length (x), centered at 0

// port positions
const port1X = -20;
const port2X = 20;

// derived
const halfL = wgL / 2;

// setup FDTD
const FDTD = new OpenEMS({ NrTS: 10000, EndCriteria: 1e-5 });
FDTD.SetGaussExcite(f0, fc);
FDTD.SetBoundaryCond(['PML_8','PML_8','PEC','PEC','PEC','PEC']);

const CSX = new ContinuousStructure();
FDTD.SetCSX(CSX);

const mesh = CSX.GetGrid();
mesh.SetDeltaUnit(unit);

// mesh — x (propagation direction)
mesh.AddLine('x', [-halfL, port1X, 0, port2X, halfL]);
mesh.SmoothMeshLines('x', 3, 1.3);

// mesh — y (broad wall)
mesh.AddLine('y', [0, wgW]);
mesh.SmoothMeshLines('y', 1.27, 1.3);

// mesh — z (narrow wall)
mesh.AddLine('z', [0, wgH]);
mesh.SmoothMeshLines('z', 1.27, 1.3);

// PEC waveguide walls (4 walls along x)
const walls = CSX.AddMetal('wg_walls');
walls.AddBox([-halfL, 0, 0], [halfL, 0, wgH], 10);       // y=0 wall
walls.AddBox([-halfL, wgW, 0], [halfL, wgW, wgH], 10);   // y=wgW wall
walls.AddBox([-halfL, 0, 0], [halfL, wgW, 0], 10);       // z=0 wall
walls.AddBox([-halfL, 0, wgH], [halfL, wgW, wgH], 10);   // z=wgH wall

// TE10 excitation at port 1
const excite = CSX.AddExcitation('port_excite_1', 0, [0, 1, 0]);
excite.AddBox([port1X, 0, 0], [port1X, wgW, wgH], 5);

// voltage probe at port 1 (midline)
const vProbe1 = CSX.AddProbe('port_ut1', 0, { weight: -1 });
vProbe1.AddBox([port1X, 0, wgH / 2], [port1X, wgW, wgH / 2], 0);

// current probe at port 1
const iProbe1 = CSX.AddProbe('port_it1', 1, { weight: 1, normDir: 0 });
iProbe1.AddBox([port1X, 0, 0], [port1X, wgW, wgH], 0);

// voltage probe at port 2 (midline)
const vProbe2 = CSX.AddProbe('port_ut2', 0, { weight: -1 });
vProbe2.AddBox([port2X, 0, wgH / 2], [port2X, wgW, wgH / 2], 0);

// current probe at port 2
const iProbe2 = CSX.AddProbe('port_it2', 1, { weight: 1, normDir: 0 });
iProbe2.AddBox([port2X, 0, 0], [port2X, wgW, wgH], 0);

return FDTD.GenerateXML();
`
};
