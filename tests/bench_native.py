#!/usr/bin/env python3
"""Run native openEMS benchmarks matching the browser test grid sizes."""

import json
import math
import os
import re
import subprocess
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OPENEMS = os.path.join(ROOT, "build-native", "openEMS")
RESULTS_FILE = os.path.join(ROOT, "tests", "fixtures", "native_bench.json")


def make_xml(nx, ny, nz, steps):
    sp = 1e-3
    mx, my, mz = nx // 2, ny // 2, nz // 2

    def grid_lines(n):
        return ",".join(f"{i * sp:.10e}" for i in range(n))

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="{steps}" endCriteria="1e-20" f_max="1e11">
    <Excitation Type="0" f0="5e10" fc="5e10"/>
    <BoundaryCond xmin="0" xmax="0" ymin="0" ymax="0" zmin="0" zmax="0"/>
  </FDTD>
  <ContinuousStructure CoordSystem="0">
    <RectilinearGrid DeltaUnit="1" CoordSystem="0">
      <XLines>{grid_lines(nx)}</XLines>
      <YLines>{grid_lines(ny)}</YLines>
      <ZLines>{grid_lines(nz)}</ZLines>
    </RectilinearGrid>
    <Properties>
      <Excitation ID="0" Name="exc" Number="0" Type="0" Excite="0,0,1">
        <Primitives>
          <Curve Priority="0">
            <Vertex X="{mx * sp}" Y="{my * sp}" Z="{mz * sp}"/>
            <Vertex X="{(mx+1) * sp}" Y="{(my+1) * sp}" Z="{(mz+1) * sp}"/>
          </Curve>
        </Primitives>
      </Excitation>
    </Properties>
  </ContinuousStructure>
</openEMS>"""


def run_bench(nx, ny, nz, steps, engine="basic"):
    sim_dir = os.path.join(ROOT, "build-native", f"bench_{nx}_{ny}_{nz}_{engine}")
    os.makedirs(sim_dir, exist_ok=True)

    xml_path = os.path.join(sim_dir, "bench.xml")
    with open(xml_path, "w") as f:
        f.write(make_xml(nx, ny, nz, steps))

    result = subprocess.run(
        [OPENEMS, xml_path, f"--engine={engine}"],
        capture_output=True,
        text=True,
        cwd=sim_dir,
    )

    speed = None
    elapsed = None
    for line in result.stdout.split("\n"):
        m = re.search(r"Speed:\s+([\d.]+)\s+MCells/s", line)
        if m:
            speed = float(m.group(1))
        m = re.search(r"Time for \d+ iterations.*:\s+([\d.]+)\s+sec", line)
        if m:
            elapsed = float(m.group(1))

    shutil.rmtree(sim_dir, ignore_errors=True)
    return speed, elapsed


def main():
    if not os.path.exists(OPENEMS):
        print(f"ERROR: Native openEMS not found at {OPENEMS}")
        sys.exit(1)

    sizes = [
        (16, 16, 16),
        (32, 32, 32),
        (64, 64, 64),
    ]
    engines = ["basic", "sse", "multithreaded"]
    steps = 105

    results = {}

    print(f"{'Grid':<14} | {'basic':>12} | {'sse':>12} | {'multithreaded':>14}")
    print(f"{'-'*14}-+-{'-'*12}-+-{'-'*12}-+-{'-'*14}")

    for nx, ny, nz in sizes:
        label = f"{nx}x{ny}x{nz}"
        results[label] = {}
        row = f"{label:<14}"

        for engine in engines:
            speed, elapsed = run_bench(nx, ny, nz, steps, engine)
            results[label][engine] = speed
            if speed:
                row += f" | {speed:>8.1f} MC/s"
            else:
                row += f" | {'FAIL':>12}"

        print(row)

    with open(RESULTS_FILE, "w") as f:
        json.dump(results, f, indent=2)

    print(f"\nResults saved to {RESULTS_FILE}")


if __name__ == "__main__":
    main()
