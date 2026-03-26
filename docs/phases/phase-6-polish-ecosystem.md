# Phase 6: Polish & Ecosystem

## Available Examples to Port

### Antennas
- `Patch_Antenna` — rectangular microstrip patch
- `Patch_Antenna_Array` — array of patch elements
- `infDipol` — infinitesimal dipole
- `Bi_Quad_Antenna` — bi-quad design
- `inverted_f` — inverted-F antenna

### Waveguides
- `Rect_Waveguide` — rectangular waveguide
- `Circ_Waveguide` — circular waveguide
- `Coax` (3 variants) — coaxial transmission line

### Transmission Lines
- `MSL` — microstrip line
- `MSL_Losses` — microstrip line with loss modeling
- `Stripline` — stripline
- `Finite_Stripline` — finite-width stripline
- `CPW_Line` — coplanar waveguide
- `directional_coupler` — coupled-line directional coupler

### Other
- `PlaneWave` — plane wave excitation
- `Helix` — helical antenna
- `LumpedElement` — lumped element demo
- `Metamaterial_PlaneWave_Drude` — Drude metamaterial with plane wave
- `PML_reflection_analysis` — PML boundary reflection study
- `resistance_sheet` — resistive sheet modeling

## Patch Antenna Example Details

Reference design for the primary demo:

| Parameter | Value |
|-----------|-------|
| Patch size | 32.86 x 41.37 mm |
| Substrate | FR4, epsilon_r = 3.38 |
| Substrate thickness | 1.524 mm |
| Ground plane | 60 x 60 mm |
| Feed | Lumped port, 50 ohm, at x = -5.5 mm, z-direction |
| Excitation | Gaussian, 0-6 GHz |
| Max timesteps | 30000 |
| End criteria | 1e-5 |

**Analysis outputs:** S11, input impedance (Zin), NF2FF (radiated power, max directivity, efficiency).

## XML Format

The openEMS simulation is defined by an XML file with this structure:

```xml
<openEMS>
  <FDTD NumberOfTimesteps="20000" endCriteria="1e-6" ...>
    <Excitation Type="0" f0="4.5e9" fc="4.5e9"/>
    <BoundaryCond xmin="0" xmax="0" ymin="0" ymax="0" zmin="0" zmax="0"/>
  </FDTD>
  <ContinuousStructure>
    <RectilinearGrid DeltaUnit="1e-3">
      <XLines>...</XLines>
      <YLines>...</YLines>
      <ZLines>...</ZLines>
    </RectilinearGrid>
    <Properties>
      <!-- Metal, material, lumped port, probe, dump definitions -->
    </Properties>
  </ContinuousStructure>
</openEMS>
```

Key sections:
- `<FDTD>`: timestep count, end criteria, excitation type and parameters, boundary conditions
- `<ContinuousStructure>`: mesh definition and all geometric/material properties
- Boundary condition codes: 0 = PEC, 1 = PMC, 2 = MUR, 3 = PML (with configurable cells)

## ReadUI File Format

ASCII tab-separated values used for voltage/current probe output:

```
% time [s]        voltage [V]
% openEMS v0.0.35
% x-coords: [x1, x2]
% y-coords: [y1, y2]
% z-coords: [z1, z2]
1.234e-12    0.00567
2.468e-12    0.01234
...
```

- Column 1: time in seconds
- Column 2: value (voltage in V or current in A)
- Comment lines start with `%`
- Header comments include probe coordinates and openEMS version

## HDF5 Field Data Structure

```
/Mesh/
  x: float64[]          # X coordinate array
  y: float64[]          # Y coordinate array
  z: float64[]          # Z coordinate array
  @MeshType: string     # "Cartesian" or "Cylindrical"

/FieldData/TD/
  00000001/             # Timestep group
    @time: float64      # Simulation time in seconds
    Ex: float32[nx,ny,nz]
    Ey: float32[nx,ny,nz]
    Ez: float32[nx,ny,nz]
  00000002/
    ...

/FieldData/FD/
  f0_real/              # Frequency bin 0, real part
    @frequency: float64
    Ex: float32[nx,ny,nz]
    ...
  f0_imag/              # Frequency bin 0, imaginary part
    ...
```

## Analysis Functions to Port

### calcPort

Dispatches based on port type:
- `calcLumpedPort` — lumped element ports
- `calcTLPort` — transmission line ports
- `calcWGPort` — waveguide ports

### calcLumpedPort

Incident/reflected wave decomposition:

```
uf_inc = 0.5 * (u + i * Z)
if_inc = 0.5 * (i + u / Z)
uf_ref = u - uf_inc
if_ref = i - if_inc
```

Where `u` is voltage, `i` is current, `Z` is reference impedance.

### FFT_time2freq

1. Assume uniform `dt` spacing
2. Zero-pad to next power of 2
3. Apply FFT, scale by `dt`
4. Take single-sided spectrum
5. Apply phase correction for time offset

### CalcNF2FF

Calls the nf2ff computation (library or binary), then reads HDF5 results containing E_theta, E_phi, radiated power, and directivity.

## Python Tutorials

Reference tutorials that demonstrate the analysis workflow:

| Tutorial | Key Concepts |
|----------|-------------|
| Simple_Patch_Antenna | Basic setup, S11, NF2FF |
| Bent_Patch_Antenna | Curved geometry |
| Helical_Antenna | 3D winding, circular polarization |
| Rect_Waveguide | Waveguide modes, port extraction |
| CRLH_Extraction | Metamaterial parameter extraction |
| MSL_NotchFilter | Coupled resonators, filter design |
| RCS_Sphere | Radar cross section, plane wave |

## Example Porting Plan

### Priority 1 — Core demos (ship with v1.0)
1. **Patch_Antenna** — the canonical antenna example; validates S11, impedance, and NF2FF
2. **MSL** — simplest transmission line; validates port calculation and FFT
3. **Rect_Waveguide** — validates waveguide port extraction

### Priority 2 — Extended library
4. **Patch_Antenna_Array** — demonstrates array patterns
5. **Helix** — 3D geometry, circular polarization
6. **CPW_Line** — coplanar waveguide, different port type
7. **Coax** — cylindrical coordinate variant

### Priority 3 — Advanced
8. **Metamaterial_PlaneWave_Drude** — dispersive materials
9. **directional_coupler** — coupled structures
10. **PML_reflection_analysis** — boundary condition validation

### Porting process per example
1. Convert the Python/Matlab setup script to a JSON or XML configuration
2. Verify simulation runs in WebAssembly and produces matching results (S11 within 0.5 dB)
3. Build an interactive parameter panel (substrate thickness, patch dimensions, frequency range)
4. Add guided annotations explaining each step
5. Write a short description for the example gallery

## IDE Integration Spec

The web IDE provides a complete simulation workflow:

### Editor Panel
- XML syntax highlighting for openEMS configuration files
- Schema-aware autocomplete for element names and attributes
- Inline validation: flag unknown elements, out-of-range values, missing required fields
- Template insertion: right-click to insert common structures (port, probe, material)

### Simulation Panel
- Run/Stop controls with progress bar (timestep count, energy decay)
- Real-time convergence plot (energy vs timestep)
- Console output: meshing stats, timestep info, warnings
- Parameter sweep mode: define a variable, set range, queue multiple runs

### Results Panel
- S-parameter plots (magnitude in dB, phase, Smith chart)
- Impedance plots (real/imaginary vs frequency)
- 2D/3D field visualization with slice controls
- NF2FF radiation pattern (polar and 3D)
- Export: PNG plots, CSV data, HDF5 raw data

### Layout
- Three-panel layout: editor (left), 3D viewport (center), results (right)
- Collapsible panels for small screens
- Tabs within each panel for multiple files/plots
- Drag-and-drop file import for XML configurations

## URL Sharing Design

Every simulation state should be shareable via URL:

### Encoding Strategy
- **Short simulations** (XML < 10 KB): compress with pako (zlib), base64url-encode, store in URL fragment (`#config=...`)
- **Large simulations**: store configuration in IndexedDB, generate a short ID, encode as `#id=...` (local only)
- **Cloud sharing** (future): POST to a storage backend, return a short URL like `antenna.app/s/abc123`

### URL Fragment Format
```
#config=<base64url(pako.deflate(xml))>&view=results&tab=s11&freq=2.4e9
```

Parameters:
- `config` — compressed XML configuration
- `view` — active panel (`editor`, `sim`, `results`)
- `tab` — active results tab (`s11`, `zin`, `nf2ff`, `fields`)
- `freq` — selected frequency for NF2FF display
- `theta` / `phi` — radiation pattern view angles

### Behavior
- On load: decompress config, populate editor, optionally auto-run simulation
- Changing parameters updates the URL fragment in real time (no page reload)
- Browser back/forward navigates parameter history
- Copy-link button in toolbar with tooltip confirmation

## Deployment Checklist

### Build
- [ ] Production WASM build with `-O3 -flto` and SIMD enabled
- [ ] Gzip or Brotli pre-compression for `.wasm` and `.js` files
- [ ] Asset fingerprinting (content hash in filenames) for cache busting
- [ ] Source maps generated but hosted separately (not shipped to users)
- [ ] Bundle size budget: WASM < 5 MB compressed, JS < 500 KB compressed

### Headers & Security
- [ ] `Cross-Origin-Opener-Policy: same-origin` (required for SharedArrayBuffer)
- [ ] `Cross-Origin-Embedder-Policy: require-corp` (required for SharedArrayBuffer)
- [ ] `Content-Security-Policy` allowing `wasm-unsafe-eval` and worker blob URLs
- [ ] HTTPS enforced (SharedArrayBuffer requires secure context)

### Browser Compatibility
- [ ] Chrome 91+ (SharedArrayBuffer re-enabled)
- [ ] Firefox 79+ (SharedArrayBuffer with headers)
- [ ] Safari 15.2+ (SharedArrayBuffer support)
- [ ] Edge 91+ (Chromium-based)
- [ ] Fallback: detect missing SharedArrayBuffer, show message with browser upgrade suggestion
- [ ] Fallback: single-threaded engine when threads unavailable

### Performance
- [ ] WASM streaming compilation (`WebAssembly.compileStreaming`)
- [ ] Thread pool pre-warming on page load
- [ ] Lazy-load NF2FF and SAR modules (not needed until post-processing)
- [ ] Web Worker for simulation engine (keep UI responsive)
- [ ] Memory limit detection and warning (check `navigator.deviceMemory` where available)

### Testing
- [ ] Regression tests: known antenna results match within tolerance
- [ ] Cross-browser automated tests (Playwright)
- [ ] Memory leak tests: run simulation 10x, check heap growth
- [ ] Performance benchmarks: patch antenna < 30s on modern hardware
- [ ] Mobile device testing: iPad Pro as minimum target

### Monitoring
- [ ] Error reporting (uncaught exceptions, WASM traps)
- [ ] Performance telemetry (simulation time, mesh size, thread count)
- [ ] Usage analytics (which examples are popular, common parameter ranges)
- [ ] Crash recovery: auto-save simulation state to IndexedDB every 60s

### Documentation
- [ ] Getting started guide with the patch antenna example
- [ ] API reference for the JavaScript simulation interface
- [ ] Example gallery with thumbnails and descriptions
- [ ] FAQ: browser requirements, performance tips, known limitations
- [ ] Changelog for each release
