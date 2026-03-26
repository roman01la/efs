#!/usr/bin/env python3
"""
Run the 3 Phase 6 examples with native openEMS and generate reference data
for comparison with WASM results.
"""

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OPENEMS = os.path.join(ROOT, "build-native", "openEMS")
C0 = 299792458.0
MUE0 = 4e-7 * math.pi
EPS0 = 1.0 / (MUE0 * C0 * C0)
Z0 = math.sqrt(MUE0 / EPS0)

sys.path.insert(0, os.path.join(ROOT, "vendor", "openEMS", "python"))
sys.path.insert(0, os.path.join(ROOT, "vendor", "CSXCAD", "python"))

from CSXCAD import ContinuousStructure
from openEMS import openEMS
from openEMS.physical_constants import *


def parse_probe(path):
    """Read a probe file (TSV with % comment lines)."""
    time, values = [], []
    with open(path) as f:
        for line in f:
            if line.startswith('%') or not line.strip():
                continue
            parts = line.split()
            time.append(float(parts[0]))
            values.append(float(parts[1]))
    return np.array(time), np.array(values)


def dft(time, values, freqs):
    """Compute DFT at specific frequencies."""
    dt = time[1] - time[0]
    N = len(time)
    re = np.zeros(len(freqs))
    im = np.zeros(len(freqs))
    for i, f in enumerate(freqs):
        for n in range(N):
            phase = 2 * math.pi * f * time[n]
            re[i] += values[n] * math.cos(phase) * dt
            im[i] -= values[n] * math.sin(phase) * dt
    return re, im


def run_patch_antenna():
    """Run Simple_Patch_Antenna natively."""
    print("\n=== Patch Antenna (Native) ===")
    sim_path = os.path.join(tempfile.gettempdir(), "native_patch")

    patch_width, patch_length = 32, 40
    substrate_epsR = 3.38
    substrate_kappa = 1e-3 * 2 * np.pi * 2.45e9 * EPS0 * substrate_epsR
    substrate_width, substrate_length = 60, 60
    substrate_thickness = 1.524
    substrate_cells = 4
    feed_pos, feed_R = -6, 50
    SimBox = np.array([200, 200, 150])
    f0, fc = 2e9, 1e9

    FDTD = openEMS(NrTS=30000, EndCriteria=1e-4)
    FDTD.SetGaussExcite(f0, fc)
    FDTD.SetBoundaryCond(['MUR'] * 6)

    CSX = ContinuousStructure()
    FDTD.SetCSX(CSX)
    mesh = CSX.GetGrid()
    mesh.SetDeltaUnit(1e-3)
    mesh_res = C0 / (f0 + fc) / 1e-3 / 20

    mesh.AddLine('x', [-SimBox[0]/2, SimBox[0]/2])
    mesh.AddLine('y', [-SimBox[1]/2, SimBox[1]/2])
    mesh.AddLine('z', [-SimBox[2]/3, SimBox[2]*2/3])

    patch = CSX.AddMetal('patch')
    patch.AddBox([-patch_width/2, -patch_length/2, substrate_thickness],
                 [patch_width/2, patch_length/2, substrate_thickness], priority=10)
    FDTD.AddEdges2Grid(dirs='xy', properties=patch, metal_edge_res=mesh_res/2)

    substrate = CSX.AddMaterial('substrate', epsilon=substrate_epsR, kappa=substrate_kappa)
    substrate.AddBox([-substrate_width/2, -substrate_length/2, 0],
                     [substrate_width/2, substrate_length/2, substrate_thickness])

    mesh.AddLine('z', np.linspace(0, substrate_thickness, substrate_cells+1))

    gnd = CSX.AddMetal('gnd')
    gnd.AddBox([-substrate_width/2, -substrate_length/2, 0],
               [substrate_width/2, substrate_length/2, 0], priority=10)
    FDTD.AddEdges2Grid(dirs='xy', properties=gnd)

    port = FDTD.AddLumpedPort(1, feed_R, [feed_pos, 0, 0],
                               [feed_pos, 0, substrate_thickness], 'z', 1.0,
                               priority=5, edges2grid='xy')

    mesh.SmoothMeshLines('all', mesh_res, 1.4)

    FDTD.Run(sim_path, cleanup=True)

    f = np.linspace(max(1e9, f0-fc), f0+fc, 401)
    port.CalcPort(sim_path, f)
    s11 = port.uf_ref / port.uf_inc
    s11_dB = 20 * np.log10(np.abs(s11))

    Zin = port.uf_tot / port.if_tot

    idx = np.argmin(s11_dB)
    print(f"  Resonance: {f[idx]/1e9:.3f} GHz")
    print(f"  S11 min: {s11_dB[idx]:.1f} dB")
    print(f"  Zin(Re) at resonance: {np.real(Zin[idx]):.1f} Ohm")

    return {
        "name": "patch_antenna",
        "freq": f.tolist(),
        "s11_dB": s11_dB.tolist(),
        "zin_re": np.real(Zin).tolist(),
        "zin_im": np.imag(Zin).tolist(),
        "resonance_freq": float(f[idx]),
        "s11_min_dB": float(s11_dB[idx]),
    }


def run_msl_notch():
    """Run MSL Notch Filter natively."""
    print("\n=== MSL Notch Filter (Native) ===")
    sim_path = os.path.join(tempfile.gettempdir(), "native_msl")

    unit = 1e-6
    MSL_length, MSL_width = 50000, 600
    substrate_thickness, substrate_epr = 254, 3.66
    stub_length = 12e3
    f_max = 7e9

    FDTD = openEMS()
    FDTD.SetGaussExcite(f_max/2, f_max/2)
    FDTD.SetBoundaryCond(['PML_8', 'PML_8', 'MUR', 'MUR', 'PEC', 'MUR'])

    CSX = ContinuousStructure()
    FDTD.SetCSX(CSX)
    mesh = CSX.GetGrid()
    mesh.SetDeltaUnit(unit)

    resolution = C0 / (f_max * np.sqrt(substrate_epr)) / unit / 50
    third_mesh = np.array([2*resolution/3, -resolution/3]) / 4

    mesh.AddLine('x', 0)
    mesh.AddLine('x', MSL_width/2 + third_mesh)
    mesh.AddLine('x', -MSL_width/2 - third_mesh)
    mesh.SmoothMeshLines('x', resolution/4)
    mesh.AddLine('x', [-MSL_length, MSL_length])
    mesh.SmoothMeshLines('x', resolution)

    mesh.AddLine('y', 0)
    mesh.AddLine('y', MSL_width/2 + third_mesh)
    mesh.AddLine('y', -MSL_width/2 - third_mesh)
    mesh.SmoothMeshLines('y', resolution/4)
    mesh.AddLine('y', [-15*MSL_width, 15*MSL_width + stub_length])
    mesh.AddLine('y', (MSL_width/2 + stub_length) + third_mesh)
    mesh.SmoothMeshLines('y', resolution)

    mesh.AddLine('z', np.linspace(0, substrate_thickness, 5))
    mesh.AddLine('z', 3000)
    mesh.SmoothMeshLines('z', resolution)

    substrate = CSX.AddMaterial('RO4350B', epsilon=substrate_epr)
    substrate.AddBox([-MSL_length, -15*MSL_width, 0],
                     [MSL_length, 15*MSL_width + stub_length, substrate_thickness])

    pec = CSX.AddMetal('PEC')
    port = [None, None]
    port[0] = FDTD.AddMSLPort(1, pec,
        [-MSL_length, -MSL_width/2, substrate_thickness],
        [0, MSL_width/2, 0], 'x', 'z', excite=-1,
        FeedShift=10*resolution, MeasPlaneShift=MSL_length/3, priority=10)
    port[1] = FDTD.AddMSLPort(2, pec,
        [MSL_length, -MSL_width/2, substrate_thickness],
        [0, MSL_width/2, 0], 'x', 'z',
        MeasPlaneShift=MSL_length/3, priority=10)

    pec.AddBox([-MSL_width/2, MSL_width/2, substrate_thickness],
               [MSL_width/2, MSL_width/2 + stub_length, substrate_thickness], priority=10)

    FDTD.Run(sim_path, cleanup=True)

    f = np.linspace(1e6, f_max, 1601)
    for p in port:
        p.CalcPort(sim_path, f, ref_impedance=50)

    s11 = port[0].uf_ref / port[0].uf_inc
    s21 = port[1].uf_ref / port[0].uf_inc
    s11_dB = 20 * np.log10(np.abs(s11))
    s21_dB = 20 * np.log10(np.abs(s21))

    idx = np.argmin(s21_dB)
    print(f"  Notch: {f[idx]/1e9:.2f} GHz")
    print(f"  S21 min: {s21_dB[idx]:.1f} dB")
    print(f"  S11 at notch: {s11_dB[idx]:.1f} dB")

    return {
        "name": "msl_notch_filter",
        "freq": f.tolist(),
        "s11_dB": s11_dB.tolist(),
        "s21_dB": s21_dB.tolist(),
        "notch_freq": float(f[idx]),
        "s21_min_dB": float(s21_dB[idx]),
    }


def run_rect_waveguide():
    """Run Rect Waveguide natively."""
    print("\n=== Rectangular Waveguide (Native) ===")
    sim_path = os.path.join(tempfile.gettempdir(), "native_wg")

    unit = 1e-6
    a, b, length = 10700, 4300, 50000
    f_start, f_0, f_stop = 20e9, 24e9, 26e9
    lambda0 = C0 / f_0 / unit
    mesh_res = lambda0 / 30

    FDTD = openEMS(NrTS=1e4)
    FDTD.SetGaussExcite(0.5*(f_start+f_stop), 0.5*(f_stop-f_start))
    FDTD.SetBoundaryCond([0, 0, 0, 0, 3, 3])

    CSX = ContinuousStructure()
    FDTD.SetCSX(CSX)
    mesh = CSX.GetGrid()
    mesh.SetDeltaUnit(unit)

    mesh.AddLine('x', [0, a])
    mesh.AddLine('y', [0, b])
    mesh.AddLine('z', [0, length])

    ports = []
    start = [0, 0, 10*mesh_res]
    stop = [a, b, 15*mesh_res]
    mesh.AddLine('z', [start[2], stop[2]])
    ports.append(FDTD.AddRectWaveGuidePort(0, start, stop, 'z', a*unit, b*unit, 'TE10', 1))

    start = [0, 0, length-10*mesh_res]
    stop = [a, b, length-15*mesh_res]
    mesh.AddLine('z', [start[2], stop[2]])
    ports.append(FDTD.AddRectWaveGuidePort(1, start, stop, 'z', a*unit, b*unit, 'TE10'))

    mesh.SmoothMeshLines('all', mesh_res, ratio=1.4)

    FDTD.Run(sim_path, cleanup=True)

    freq = np.linspace(f_start, f_stop, 201)
    for port in ports:
        port.CalcPort(sim_path, freq)

    s11 = ports[0].uf_ref / ports[0].uf_inc
    s21 = ports[1].uf_ref / ports[0].uf_inc
    ZL = ports[0].uf_tot / ports[0].if_tot
    ZL_a = ports[0].ZL

    s11_dB = 20 * np.log10(np.abs(s11))
    s21_dB = 20 * np.log10(np.abs(s21))

    mid = len(freq) // 2
    print(f"  S21 at center: {s21_dB[mid]:.2f} dB")
    print(f"  S11 at center: {s11_dB[mid]:.2f} dB")
    print(f"  ZL(Re) at center: {np.real(ZL[mid]):.1f} Ohm (analytic: {ZL_a[mid]:.1f})")

    return {
        "name": "rect_waveguide",
        "freq": freq.tolist(),
        "s11_dB": s11_dB.tolist(),
        "s21_dB": s21_dB.tolist(),
        "ZL_re": np.real(ZL).tolist(),
        "ZL_im": np.imag(ZL).tolist(),
        "ZL_analytic": ZL_a.tolist(),
    }


if __name__ == "__main__":
    results = {}
    results["patch"] = run_patch_antenna()
    results["msl"] = run_msl_notch()
    results["waveguide"] = run_rect_waveguide()

    out = os.path.join(ROOT, "tests", "fixtures", "examples_native_reference.json")
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nReference saved to {out}")
