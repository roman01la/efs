# Phase 2: TypeScript API & Visualization

## Python API to Mirror

### openEMS Constructor (from openEMS.pyx)

Constructor keyword arguments:

| Parameter | Type | Description |
|-----------|------|-------------|
| NrTS | int | Number of timesteps |
| EndCriteria | float | End criteria threshold |
| MaxTime | float | Maximum simulation time |
| OverSampling | int | Oversampling factor |
| CoordSystem | int | Coordinate system (0=Cartesian, 1=Cylindrical) |
| MultiGrid | string | Multi-grid definition |
| TimeStep | float | Fixed timestep |
| TimeStepFactor | float | Timestep scaling factor |
| TimeStepMethod | int | Timestep calculation method |
| CellConstantMaterial | bool | Cell constant material flag |

### Excitation Methods

- `SetGaussExcite(f0, fc)` -- Gaussian pulse centered at f0 with cutoff fc
- `SetSinusExcite(f0)` -- Sinusoidal excitation at f0
- `SetDiracExcite(fmax)` -- Dirac delta with bandwidth fmax
- `SetStepExcite(fmax)` -- Step function with bandwidth fmax
- `SetCustomExcite(str, f0, fmax)` -- Custom function string, center f0, bandwidth fmax

### Boundary Conditions

`SetBoundaryCond(array)` -- 6-element array `[xmin, xmax, ymin, ymax, zmin, zmax]`

| Value | Type |
|-------|------|
| 0 or "PEC" | Perfect Electric Conductor |
| 1 or "PMC" | Perfect Magnetic Conductor |
| 2 or "MUR" | Mur absorbing BC |
| 3 or "PML_N" | Perfectly Matched Layer (N cells) |

### Port Methods

- `AddLumpedPort(port_nr, R, start, stop, p_dir, excite)`
- `AddMSLPort(port_nr, metal_prop, start, stop, prop_dir, exc_dir, excite)`
- `AddRectWaveGuidePort(port_nr, start, stop, p_dir, a, b, mode_name, excite)`
- `AddWaveGuidePort(port_nr, start, stop, p_dir, E_func, H_func, kc, excite)`

### NF2FF

- `CreateNF2FFBox(name, start, stop, directions, mirror, frequency)`

### CSX / Simulation Control

- `SetCSX(csx)`, `GetCSX()`
- `AddEdges2Grid(dirs, properties, metal_edge_res)`
- `Write2XML(file)`, `ReadFromXML(file)`
- `Run(sim_path, cleanup, setup_only)`

## CSXCAD Python API (from CSXCAD.pyx)

### ContinuousStructure

- `AddMaterial(name)` -- Returns MaterialProperty
- `AddMetal(name)` -- Returns MetalProperty
- `AddConductingSheet(name, conductivity, thickness)` -- Returns ConductingSheetProperty
- `AddLumpedElement(name, ny, R, C, L)` -- Returns LumpedElementProperty
- `AddExcitation(name, type, val)` -- Returns ExcitationProperty
- `AddProbe(name, type)` -- Returns ProbeProperty
- `AddDump(name)` -- Returns DumpProperty
- `GetGrid()` -- Returns CSRectGrid
- `DefineGrid(f, unit, lines)` -- Define grid from frequency/unit/lines

### Primitives (via properties)

- `AddPoint(coord)`
- `AddBox(start, stop)`
- `AddCylinder(start, stop, radius)`
- `AddCylindricalShell(start, stop, radius, shell_width)`
- `AddSphere(center, radius)`
- `AddSphericalShell(center, radius, shell_width)`
- `AddPolygon(points, norm_dir, elevation)`
- `AddLinPoly(points, norm_dir, elevation, length)`
- `AddRotPoly(points, norm_dir, elevation, angle)`
- `AddCurve(points)`
- `AddWire(points, radius)`

## TypeScript Interface Definitions

### Physical Constants

```typescript
export const C0 = 299792458;                    // speed of light [m/s]
export const MUE0 = 4e-7 * Math.PI;             // permeability [H/m]
export const EPS0 = 1 / (MUE0 * C0 * C0);       // permittivity [F/m]
export const Z0 = Math.sqrt(MUE0 / EPS0);        // free space impedance ~ 376.73 Ohm
```

### Core Simulation

```typescript
export type Vec3 = [number, number, number];
export type BoundaryType = 'PEC' | 'PMC' | 'MUR' | `PML_${number}`;
export type BoundaryCond = [BoundaryType, BoundaryType, BoundaryType, BoundaryType, BoundaryType, BoundaryType];

export type ExcitationType =
  | { type: 'gauss'; f0: number; fc: number }
  | { type: 'sinus'; f0: number }
  | { type: 'dirac'; fmax: number }
  | { type: 'step'; fmax: number }
  | { type: 'custom'; func: string; f0: number; fmax: number };

export type CoordSystem = 'cartesian' | 'cylindrical';

export interface SimulationConfig {
  nrTS?: number;
  endCriteria?: number;
  maxTime?: number;
  overSampling?: number;
  coordSystem?: CoordSystem;
  multiGrid?: string;
  timeStep?: number;
  timeStepFactor?: number;
  timeStepMethod?: number;
  cellConstantMaterial?: boolean;
}

export interface Simulation {
  configure(config: SimulationConfig): void;
  setExcitation(excitation: ExcitationType): void;
  setBoundaryCond(bc: BoundaryCond): void;
  setCSX(csx: ContinuousStructure): void;
  getCSX(): ContinuousStructure;

  addLumpedPort(params: LumpedPortParams): LumpedPort;
  addMSLPort(params: MSLPortParams): MSLPort;
  addRectWaveGuidePort(params: RectWGPortParams): RectWGPort;
  addWaveGuidePort(params: WaveGuidePortParams): WaveGuidePort;

  createNF2FFBox(params: NF2FFParams): NF2FFBox;

  write2XML(file: string): void;
  readFromXML(file: string): void;
  run(simPath: string, options?: { cleanup?: boolean; setupOnly?: boolean }): Promise<void>;
}
```

### Port Class Hierarchy

```typescript
// Base port
export interface PortData {
  frequency: Float64Array;
  uf_inc: Float64Array;
  uf_ref: Float64Array;
  if_inc: Float64Array;
  if_ref: Float64Array;
  P_inc: Float64Array;
  P_ref: Float64Array;
  P_acc: Float64Array;
  Z_ref: number;
}

export interface Port {
  readonly number: number;
  readonly start: Vec3;
  readonly stop: Vec3;
  readonly excite: boolean;
  Z_ref: number;

  readUIData(simPath: string, freq: Float64Array): void;
  calcPort(simPath: string, freq: Float64Array): PortData;
}

// Lumped port: R + voltage/current probes
export interface LumpedPortParams {
  portNr: number;
  R: number;
  start: Vec3;
  stop: Vec3;
  pDir: number;       // 0=x, 1=y, 2=z
  excite?: boolean;
}

export interface LumpedPort extends Port {
  readonly R: number;
  readonly excDir: number;
}

// MSL port: 3 voltage + 2 current probes, beta and ZL calculation
export interface MSLPortParams {
  portNr: number;
  metalProp: string;
  start: Vec3;
  stop: Vec3;
  propDir: number;
  excDir: number;
  excite?: boolean;
  feedShift?: number;
  measPlaneShift?: number;
  feedR?: number;
}

export interface MSLPort extends Port {
  readonly propDir: number;
  readonly excDir: number;
  readonly feedShift: number;
  readonly measPlaneShift: number;
  readonly feedR: number;
  beta: Float64Array;
  ZL: Float64Array;
}

// Waveguide port: kc, E/H functions, beta and ZL
export interface WaveGuidePortParams {
  portNr: number;
  start: Vec3;
  stop: Vec3;
  pDir: number;
  E_func: [string, string, string];
  H_func: [string, string, string];
  kc: number;
  excite?: boolean;
}

export interface WaveGuidePort extends Port {
  readonly kc: number;
  beta: Float64Array;
  ZL: Float64Array;
}

// Rectangular waveguide port: TE modes only
export interface RectWGPortParams {
  portNr: number;
  start: Vec3;
  stop: Vec3;
  pDir: number;
  a: number;
  b: number;
  modeName: string;   // e.g. "TE10"
  excite?: boolean;
}

export interface RectWGPort extends WaveGuidePort {
  readonly a: number;
  readonly b: number;
  readonly modeName: string;
}
```

### CSXCAD Structure

```typescript
export type PrimitiveType =
  | 'Point' | 'Box' | 'Cylinder' | 'CylindricalShell'
  | 'Sphere' | 'SphericalShell' | 'Polygon' | 'LinPoly'
  | 'RotPoly' | 'Curve' | 'Wire';

export interface Primitive {
  readonly type: PrimitiveType;
  transform(matrix: number[]): this;
}

export interface CSProperty {
  readonly name: string;
  addPoint(coord: Vec3): Primitive;
  addBox(start: Vec3, stop: Vec3): Primitive;
  addCylinder(start: Vec3, stop: Vec3, radius: number): Primitive;
  addCylindricalShell(start: Vec3, stop: Vec3, radius: number, shellWidth: number): Primitive;
  addSphere(center: Vec3, radius: number): Primitive;
  addSphericalShell(center: Vec3, radius: number, shellWidth: number): Primitive;
  addPolygon(points: Vec3[], normDir: number, elevation: number): Primitive;
  addLinPoly(points: Vec3[], normDir: number, elevation: number, length: number): Primitive;
  addRotPoly(points: Vec3[], normDir: number, elevation: number, angle: number): Primitive;
  addCurve(points: Vec3[]): Primitive;
  addWire(points: Vec3[], radius: number): Primitive;
}

export interface MaterialProperty extends CSProperty {
  setEpsilon(eps: number | Vec3): void;
  setMue(mue: number | Vec3): void;
  setKappa(kappa: number | Vec3): void;
  setSigma(sigma: number | Vec3): void;
}

export interface MetalProperty extends CSProperty {}

export interface ConductingSheetProperty extends CSProperty {
  readonly conductivity: number;
  readonly thickness: number;
}

export interface LumpedElementProperty extends CSProperty {
  readonly ny: number;
  readonly R: number;
  readonly C: number;
  readonly L: number;
}

export interface ExcitationProperty extends CSProperty {
  readonly excType: number;
  readonly excVal: Vec3;
}

export interface ProbeProperty extends CSProperty {
  readonly probeType: number;
}

export interface DumpProperty extends CSProperty {}

export interface CSRectGrid {
  addLine(direction: number, lines: number[]): void;
  getLines(direction: number): Float64Array;
  setDeltaUnit(unit: number): void;
  smooth(maxRes: number | Vec3, direction?: number): void;
  clear(): void;
}

export interface ContinuousStructure {
  addMaterial(name: string): MaterialProperty;
  addMetal(name: string): MetalProperty;
  addConductingSheet(name: string, conductivity: number, thickness: number): ConductingSheetProperty;
  addLumpedElement(name: string, ny: number, R?: number, C?: number, L?: number): LumpedElementProperty;
  addExcitation(name: string, type: number, val: Vec3): ExcitationProperty;
  addProbe(name: string, type: number): ProbeProperty;
  addDump(name: string): DumpProperty;
  getGrid(): CSRectGrid;
  defineGrid(f: number, unit: number, lines: number[][]): void;
}
```

### NF2FF Results

```typescript
export interface NF2FFParams {
  name: string;
  start: Vec3;
  stop: Vec3;
  directions?: [boolean, boolean, boolean, boolean, boolean, boolean];
  mirror?: [number, number, number, number, number, number];
  frequency?: number[];
}

export interface NF2FFResult {
  theta: Float64Array;           // theta angles [rad]
  phi: Float64Array;             // phi angles [rad]
  r: number;                     // far-field radius [m]
  freq: number;                  // frequency [Hz]
  E_theta: Float64Array[];       // E-field theta component (complex, per theta/phi)
  E_phi: Float64Array[];         // E-field phi component (complex)
  E_norm: Float64Array[];        // normalized E-field magnitude
  E_cprh: Float64Array[];        // co-pol right-hand circular
  E_cplh: Float64Array[];        // co-pol left-hand circular
  P_rad: number;                 // total radiated power [W]
  Dmax: number;                  // maximum directivity
  Prad: number;                  // alias for P_rad
}

export interface NF2FFBox {
  calcNF2FF(
    simPath: string,
    freq: number | number[],
    theta: number[],
    phi: number[],
    options?: {
      center?: Vec3;
      radius?: number;
      verbose?: boolean;
    }
  ): Promise<NF2FFResult>;
}
```

### Automesh Utilities

```typescript
/**
 * Generate mesh hints from a primitive (e.g., box, cylinder).
 * Used to auto-generate grid lines around structures.
 */
export function meshHintFromPrimitive(
  primitive: Primitive,
  direction: number,
  metalEdgeRes?: number
): number[];

/**
 * Generate mesh hints from a box region.
 * metal_edge_res controls refinement at conductor edges.
 */
export function meshHintFromBox(
  start: Vec3,
  stop: Vec3,
  direction: number,
  metalEdgeRes?: number
): number[];

/**
 * Combine and deduplicate mesh lines, ensuring minimum spacing.
 */
export function meshCombine(
  lines1: number[],
  lines2: number[],
  minSpacing?: number
): number[];

/**
 * Estimate CFL-limited timestep from grid spacing.
 * dt <= 1 / (c0 * sqrt(1/dx^2 + 1/dy^2 + 1/dz^2))
 */
export function meshEstimateCflTimestep(
  grid: CSRectGrid,
  coordSystem?: CoordSystem
): number;
```

## Visualization Component Specs

### S-Parameter Plot

Displays S11, S21, etc. in dB vs. frequency.

```typescript
export interface SParamPlotProps {
  ports: Port[];
  frequency: Float64Array;
  /** Which S-parameters to show, e.g. [[1,1], [2,1]] for S11 and S21 */
  params: [number, number][];
  /** Y-axis range in dB, default [-40, 0] */
  yRange?: [number, number];
}
```

### Smith Chart

Plots complex impedance (Zin/Z0) or reflection coefficient on standard Smith chart.

```typescript
export interface SmithChartProps {
  frequency: Float64Array;
  /** Complex impedance Z(f) normalized to Z_ref */
  zNorm: { re: Float64Array; im: Float64Array };
  /** Highlight specific frequencies */
  markers?: number[];
}
```

### Radiation Pattern (3D)

Renders NF2FF results as a 3D radiation pattern.

```typescript
export interface RadiationPattern3DProps {
  nf2ff: NF2FFResult;
  /** 'directivity' | 'gain' | 'E_norm' */
  quantity: string;
  /** dB range below max to display */
  dynamicRange?: number;
  /** Color map name */
  colorMap?: string;
}
```

### Radiation Pattern (Polar 2D)

Standard polar plot for a single phi or theta cut.

```typescript
export interface RadiationPatternPolarProps {
  nf2ff: NF2FFResult;
  /** 'phi' | 'theta' -- which plane to cut */
  cutPlane: 'phi' | 'theta';
  /** Value of the cut angle in degrees */
  cutAngle: number;
  quantity: string;
  dynamicRange?: number;
}
```

### Impedance Plot

Real and imaginary parts of port impedance vs. frequency.

```typescript
export interface ImpedancePlotProps {
  port: Port;
  frequency: Float64Array;
  /** Show VSWR on secondary axis */
  showVSWR?: boolean;
}
```

### Time Domain Waveform

Displays raw time-domain probe data (voltage or current vs. time).

```typescript
export interface TimeDomainPlotProps {
  probes: Array<{
    label: string;
    time: Float64Array;
    values: Float64Array;
  }>;
  /** X-axis unit: 'ns' | 'us' | 'ms' | 's' */
  timeUnit?: string;
}
```

### Mesh / Structure Viewer

3D visualization of the CSXCAD structure and mesh grid.

```typescript
export interface StructureViewerProps {
  csx: ContinuousStructure;
  /** Show mesh grid lines */
  showGrid?: boolean;
  /** Show boundary condition indicators */
  showBC?: boolean;
  /** Opacity for dielectric materials */
  dielectricOpacity?: number;
  /** Highlight specific properties by name */
  highlight?: string[];
}
```
