#!/usr/bin/env python3
"""Generate reference test fixtures by running native openEMS."""

import json
import math
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "tests", "fixtures")
OPENEMS = os.path.join(ROOT, "build-native", "openEMS")

C0 = 299792458.0
MUE0 = 4e-7 * math.pi
EPS0 = 1.0 / (MUE0 * C0 * C0)
Z0 = math.sqrt(MUE0 / EPS0)


def linspace(start, stop, n):
    if n == 1:
        return [start]
    step = (stop - start) / (n - 1)
    return [start + i * step for i in range(n)]


def run_openems(sim_path, xml_file, engine="basic"):
    cmd = [OPENEMS, xml_file, f"--engine={engine}"]
    print(f"  Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=sim_path)
    if result.returncode != 0:
        print(f"  STDOUT: {result.stdout[-1000:]}")
        print(f"  STDERR: {result.stderr[-500:]}")
        raise RuntimeError(f"openEMS failed with code {result.returncode}")
    print(f"  Done ({result.stdout.count(chr(10))} lines output)")
    return result


def read_probe_csv(filepath):
    times, values = [], []
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("%"):
                continue
            parts = line.split()
            if len(parts) >= 4:
                times.append(float(parts[0]))
                ex, ey, ez = float(parts[1]), float(parts[2]), float(parts[3])
                values.append(math.sqrt(ex*ex + ey*ey + ez*ez))
            elif len(parts) >= 2:
                times.append(float(parts[0]))
                values.append(float(parts[1]))
    return times, values


def mesh_to_csv(vals):
    return ",".join(f"{v:.10e}" for v in vals)


# --------------------------------------------------------------------------
# Test 1: Rectangular cavity resonator
# --------------------------------------------------------------------------
def generate_cavity():
    print("=== Cavity resonator ===")
    sim_path = os.path.join(FIXTURES, "cavity", "sim")
    os.makedirs(sim_path, exist_ok=True)

    a = 5e-2
    b = 2e-2
    d = 6e-2

    mesh_x = linspace(0, a, 26)
    mesh_y = linspace(0, b, 11)
    mesh_z = linspace(0, d, 32)

    # Excitation at 2/3 position
    ex_idx_x = len(mesh_x) * 2 // 3
    ex_idx_y = len(mesh_y) * 2 // 3
    ex_idx_z = len(mesh_z) * 2 // 3

    # Probe at ~1/4 x, ~1/2 y, ~1/5 z
    pr_x = mesh_x[len(mesh_x) // 4]
    pr_y = mesh_y[len(mesh_y) // 2]
    pr_z_idx = len(mesh_z) // 5

    f_start = 1e9
    f_stop = 10e9
    f0 = (f_stop + f_start) / 2
    fc = (f_stop - f_start) / 2

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="20000" endCriteria="1e-6" f_max="{f_stop}">
    <Excitation Type="0" f0="{f0}" fc="{fc}"/>
    <BoundaryCond xmin="0" xmax="0" ymin="0" ymax="0" zmin="0" zmax="0"/>
  </FDTD>
  <ContinuousStructure CoordSystem="0">
    <RectilinearGrid DeltaUnit="1" CoordSystem="0">
      <XLines>{mesh_to_csv(mesh_x)}</XLines>
      <YLines>{mesh_to_csv(mesh_y)}</YLines>
      <ZLines>{mesh_to_csv(mesh_z)}</ZLines>
    </RectilinearGrid>
    <Properties>
      <Excitation ID="0" Name="excite1" Number="0" Type="0" Excite="1,1,1">
        <Primitives>
          <Curve Priority="0">
            <Vertex X="{mesh_x[ex_idx_x]}" Y="{mesh_y[ex_idx_y]}" Z="{mesh_z[ex_idx_z]}"/>
            <Vertex X="{mesh_x[ex_idx_x+1]}" Y="{mesh_y[ex_idx_y+1]}" Z="{mesh_z[ex_idx_z+1]}"/>
          </Curve>
        </Primitives>
      </Excitation>
      <ProbeBox ID="1" Name="ut1z" Number="0" Type="0" Weight="1" NormDir="-1">
        <Primitives>
          <Box Priority="0">
            <P1 X="{pr_x}" Y="{pr_y}" Z="{mesh_z[pr_z_idx]}"/>
            <P2 X="{pr_x}" Y="{pr_y}" Z="{mesh_z[pr_z_idx+1]}"/>
          </Box>
        </Primitives>
      </ProbeBox>
    </Properties>
  </ContinuousStructure>
</openEMS>"""

    xml_path = os.path.join(sim_path, "cavity.xml")
    with open(xml_path, "w") as f:
        f.write(xml)

    run_openems(sim_path, xml_path)

    def f_res(m, n, l):
        return C0 / (2 * math.pi) * math.sqrt(
            (m * math.pi / a) ** 2 + (n * math.pi / b) ** 2 + (l * math.pi / d) ** 2
        )

    reference = {
        "dimensions_m": {"a": a, "b": b, "d": d},
        "mesh_points": {"x": len(mesh_x), "y": len(mesh_y), "z": len(mesh_z)},
        "te_modes": {
            "TE101": f_res(1, 0, 1),
            "TE102": f_res(1, 0, 2),
            "TE201": f_res(2, 0, 1),
            "TE202": f_res(2, 0, 2),
        },
        "tm_modes": {
            "TM110": f_res(1, 1, 0),
            "TM111": f_res(1, 1, 1),
        },
        "tolerances": {
            "te_freq_rel": 0.0013,
            "tm_freq_lower_rel": 0.0025,
            "tm_freq_upper_rel": 0.0,
            "te_min_amplitude": 0.6,
            "tm_min_amplitude": 0.27,
            "outer_max_amplitude": 0.17,
            "outer_rel_limit": 0.02,
        },
    }

    probe_file = os.path.join(sim_path, "ut1z")
    if os.path.exists(probe_file):
        t, v = read_probe_csv(probe_file)
        reference["probe_data"] = {"time_s": t, "voltage": v}
        shutil.copy(probe_file, os.path.join(FIXTURES, "cavity", "probe_ut1z.csv"))
        print(f"  Probe has {len(t)} samples")
    else:
        print(f"  WARNING: Probe file not found at {probe_file}")
        print(f"  Files in sim_path: {os.listdir(sim_path)}")

    with open(os.path.join(FIXTURES, "cavity", "reference.json"), "w") as f:
        json.dump(reference, f, indent=2)

    shutil.rmtree(sim_path, ignore_errors=True)
    print("  Cavity reference saved")


# --------------------------------------------------------------------------
# Test 2: Coaxial transmission line
# --------------------------------------------------------------------------
def generate_coax():
    print("=== Coaxial line ===")
    sim_path = os.path.join(FIXTURES, "coax", "sim")
    os.makedirs(sim_path, exist_ok=True)

    # All dimensions in drawing units (mm), DeltaUnit=1e-3
    du = 1e-3
    length = 1000     # mm
    ri = 100          # mm inner radius
    rai = 230         # mm inner wall of outer conductor
    raa = 240         # mm outer wall of outer conductor
    res = 5           # mm mesh resolution
    f_stop = 1e9
    num_timesteps = 30000  # enough for signal to propagate and decay

    x_min = -2.5 * res - raa
    x_max = raa + 2.5 * res
    mesh_x = []
    x = x_min
    while x <= x_max + 0.001:
        mesh_x.append(x)
        x += res
    mesh_y = list(mesh_x)
    nz = int(length / res) + 1
    mesh_z = linspace(0, length, nz)

    mid_z = length / 2
    mid_shell_r = 0.5 * (raa + rai)
    shell_w = raa - rai
    cur_mid = ri + 3 * res

    # Use mesh-aligned coordinates for excitation and probes
    # Mesh has no Y=0 line (goes ...-2.5, 2.5,...), use adjacent lines
    probe_y = mesh_y[len(mesh_y) // 2]  # center-ish mesh line
    exc_y0 = mesh_y[len(mesh_y) // 2 - 1]
    exc_y1 = mesh_y[len(mesh_y) // 2 + 1]

    Z0_analytical = math.sqrt(MUE0 / EPS0) / (2 * math.pi) * math.log(rai / ri)

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="{num_timesteps}" endCriteria="1e-6" f_max="{f_stop}">
    <Excitation Type="0" f0="0" fc="{f_stop}"/>
    <BoundaryCond xmin="0" xmax="0" ymin="0" ymax="0" zmin="0" zmax="PML_8"/>
  </FDTD>
  <ContinuousStructure CoordSystem="0">
    <RectilinearGrid DeltaUnit="{du}" CoordSystem="0">
      <XLines>{mesh_to_csv(mesh_x)}</XLines>
      <YLines>{mesh_to_csv(mesh_y)}</YLines>
      <ZLines>{mesh_to_csv(mesh_z)}</ZLines>
    </RectilinearGrid>
    <Properties>
      <Metal ID="0" Name="PEC">
        <Primitives>
          <Cylinder Priority="1" Radius="{ri}">
            <P1 X="0" Y="0" Z="0"/>
            <P2 X="0" Y="0" Z="{length}"/>
          </Cylinder>
          <CylindricalShell Priority="0" Radius="{mid_shell_r}" ShellWidth="{shell_w}">
            <P1 X="0" Y="0" Z="0"/>
            <P2 X="0" Y="0" Z="{length}"/>
          </CylindricalShell>
        </Primitives>
      </Metal>
      <Excitation ID="1" Name="excite" Number="0" Type="0" Excite="1,1,0">
        <Weight X="x/(x*x+y*y)" Y="y/(x*x+y*y)" Z="0"/>
        <Primitives>
          <CylindricalShell Priority="0" Radius="{0.5*(ri+rai)}" ShellWidth="{rai-ri}">
            <P1 X="0" Y="0" Z="0"/>
            <P2 X="0" Y="0" Z="{res/2}"/>
          </CylindricalShell>
        </Primitives>
      </Excitation>
      <ProbeBox ID="2" Name="ut1" Number="0" Type="0" Weight="1" NormDir="-1">
        <Primitives>
          <Box Priority="0">
            <P1 X="{ri}" Y="{probe_y}" Z="{mid_z}"/>
            <P2 X="{rai}" Y="{probe_y}" Z="{mid_z}"/>
          </Box>
        </Primitives>
      </ProbeBox>
      <ProbeBox ID="3" Name="it1" Number="0" Type="1" Weight="1" NormDir="-1">
        <Primitives>
          <Box Priority="0">
            <P1 X="{-cur_mid}" Y="{-cur_mid}" Z="{mid_z}"/>
            <P2 X="{cur_mid}" Y="{cur_mid}" Z="{mid_z}"/>
          </Box>
        </Primitives>
      </ProbeBox>
    </Properties>
  </ContinuousStructure>
</openEMS>"""

    xml_path = os.path.join(sim_path, "coax.xml")
    with open(xml_path, "w") as f:
        f.write(xml)

    run_openems(sim_path, xml_path)

    reference = {
        "geometry_mm": {
            "r_inner": ri,
            "r_outer": rai,
            "r_outer_outer": raa,
            "length": length,
        },
        "Z0_analytical_ohm": Z0_analytical,
        "tolerances": {
            "upper_error": 0.03,
            "lower_error": 0.01,
        },
    }

    for name in ["ut1", "it1"]:
        src = os.path.join(sim_path, name)
        if os.path.exists(src):
            t, v = read_probe_csv(src)
            reference[f"probe_{name}"] = {"time_s": t, "voltage": v}
            shutil.copy(src, os.path.join(FIXTURES, "coax", f"probe_{name}.csv"))
            print(f"  Probe {name}: {len(t)} samples")
        else:
            print(f"  WARNING: Probe {name} not found")
            print(f"  Files: {os.listdir(sim_path)}")

    with open(os.path.join(FIXTURES, "coax", "reference.json"), "w") as f:
        json.dump(reference, f, indent=2)

    shutil.rmtree(sim_path, ignore_errors=True)
    print("  Coax reference saved")


# --------------------------------------------------------------------------
# Test 3: Infinitesimal dipole field probes
# --------------------------------------------------------------------------
def generate_dipole():
    print("=== Dipole field probes ===")
    sim_path = os.path.join(FIXTURES, "dipole", "sim")
    os.makedirs(sim_path, exist_ok=True)

    du = 1e-6  # drawing unit = micrometers
    f_max = 1e9
    lam = C0 / f_max / du  # wavelength in drawing units
    dipole_length = lam / 50

    # Mesh: +-20 dipole lengths, step = dipole_length/2
    half_step = dipole_length / 2
    extent = dipole_length * 20
    mesh_vals = []
    v = -extent
    while v <= extent + 0.001:
        mesh_vals.append(v)
        v += half_step
    mesh_csv = mesh_to_csv(mesh_vals)

    # Probe coordinates at +-4.5 * dipole_length/2 from center
    s = 4.5 * dipole_length / 2
    probe_coords = [
        ("et1", [-s, 0, 0], 2),   # E-field on -x
        ("et2", [s, 0, 0], 2),    # E-field on +x
        ("ht1", [-s, 0, 0], 3),   # H-field on -x
        ("ht2", [s, 0, 0], 3),    # H-field on +x
    ]

    # Snap probe coords to nearest mesh line
    def snap(val, mesh):
        closest = min(mesh, key=lambda m: abs(m - val))
        return closest

    probe_xml = ""
    for i, (name, coord, ptype) in enumerate(probe_coords):
        cx = snap(coord[0], mesh_vals)
        cy = snap(coord[1], mesh_vals)
        cz = snap(coord[2], mesh_vals)
        probe_xml += f"""
      <ProbeBox ID="{i+2}" Name="{name}" Number="0" Type="{ptype}" Weight="1" NormDir="-1">
        <Primitives>
          <Box Priority="0">
            <P1 X="{cx}" Y="{cy}" Z="{cz}"/>
            <P2 X="{cx}" Y="{cy}" Z="{cz}"/>
          </Box>
        </Primitives>
      </ProbeBox>"""

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="5000" endCriteria="1e-6" f_max="{f_max}">
    <Excitation Type="0" f0="0" fc="{f_max}"/>
    <BoundaryCond xmin="2" xmax="2" ymin="2" ymax="2" zmin="2" zmax="2"/>
  </FDTD>
  <ContinuousStructure CoordSystem="0">
    <RectilinearGrid DeltaUnit="{du}" CoordSystem="0">
      <XLines>{mesh_csv}</XLines>
      <YLines>{mesh_csv}</YLines>
      <ZLines>{mesh_csv}</ZLines>
    </RectilinearGrid>
    <Properties>
      <Excitation ID="0" Name="infDipole" Number="0" Type="1" Excite="0,0,1">
        <Primitives>
          <Curve Priority="1">
            <Vertex X="0" Y="0" Z="{-dipole_length/2}"/>
            <Vertex X="0" Y="0" Z="{dipole_length/2}"/>
          </Curve>
        </Primitives>
      </Excitation>{probe_xml}
    </Properties>
  </ContinuousStructure>
</openEMS>"""

    xml_path = os.path.join(sim_path, "dipole.xml")
    with open(xml_path, "w") as f:
        f.write(xml)

    run_openems(sim_path, xml_path)

    reference = {
        "drawing_unit": du,
        "f_max": f_max,
        "dipole_length_du": dipole_length,
        "tolerances": {
            "max_time_diff": 1e-13,
            "max_amp_diff": 1e-7,
            "min_e_amp": 5e-3,
            "min_h_amp": 1e-7,
        },
    }

    probe_names = [p[0] for p in probe_coords]
    for name in probe_names:
        src = os.path.join(sim_path, name)
        if os.path.exists(src):
            t, v = read_probe_csv(src)
            reference[f"probe_{name}"] = {"time_s": t, "voltage": v}
            shutil.copy(src, os.path.join(FIXTURES, "dipole", f"probe_{name}.csv"))
            print(f"  Probe {name}: {len(t)} samples, max={max(abs(x) for x in v):.4e}")
        else:
            print(f"  WARNING: Probe {name} not found")
            print(f"  Files: {os.listdir(sim_path)}")

    with open(os.path.join(FIXTURES, "dipole", "reference.json"), "w") as f:
        json.dump(reference, f, indent=2)

    shutil.rmtree(sim_path, ignore_errors=True)
    print("  Dipole reference saved")


# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------
def generate_constants():
    print("=== Physical constants ===")
    with open(os.path.join(FIXTURES, "constants.json"), "w") as f:
        json.dump({"C0": C0, "MUE0": MUE0, "EPS0": EPS0, "Z0": Z0}, f, indent=2)
    print("  Saved")


# --------------------------------------------------------------------------
if __name__ == "__main__":
    if not os.path.exists(OPENEMS):
        print(f"ERROR: Native openEMS not found at {OPENEMS}")
        sys.exit(1)

    os.makedirs(FIXTURES, exist_ok=True)
    generate_constants()
    generate_cavity()
    generate_coax()
    generate_dipole()
    print("\n=== All fixtures generated ===")
