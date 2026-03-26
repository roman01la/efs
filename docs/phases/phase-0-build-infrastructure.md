# Phase 0: Build Infrastructure & Reference Data

This document describes every file change required to compile openEMS and CSXCAD
to WebAssembly using Emscripten. Each section is self-contained and includes
exact file paths, line numbers, and verification criteria.

---

## 0.1 Emscripten CMake Toolchain File

Create a top-level CMake toolchain overlay that configures the Emscripten build.
This is invoked as a second CMakeLists at the project root; the vendor CMake
files are modified in place with `#ifdef`/option guards.

### 0.1.1 Create `CMakeLists.txt` (project root)

Create `/Users/romanliutikov/projects/antenna-prop/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.13)
project(antenna-prop)

# ---- user-facing options ----
option(WASM_BUILD       "Target Emscripten/WASM"           ON)
option(DISABLE_VTK      "Strip all VTK dependencies"       ON)
option(DISABLE_CGAL     "Strip CGAL (polyhedron prims)"    ON)
option(DISABLE_MPI      "Strip MPI support"                ON)

# propagate options into vendor builds
set(WITH_MPI OFF CACHE BOOL "" FORCE)

# ---- dependency order: fparser -> CSXCAD -> openEMS ----
# fparser must be built or provided externally first.
# For now assume it is built separately and installed into ${FPARSER_ROOT_DIR}.

add_subdirectory(vendor/CSXCAD)
add_subdirectory(vendor/openEMS)
```

### 0.1.2 Build invocation

```bash
emcmake cmake -B build -S . \
  -DCMAKE_BUILD_TYPE=Release \
  -DWASM_BUILD=ON \
  -DDISABLE_VTK=ON \
  -DDISABLE_CGAL=ON \
  -DDISABLE_MPI=ON \
  -DFPARSER_ROOT_DIR=$PWD/deps/fparser \
  -DCSXCAD_ROOT_DIR=$PWD/build/vendor/CSXCAD \
  -DTinyXML_ROOT_DIR=$PWD/deps/tinyxml \
  -DHDF5_ROOT=$PWD/deps/hdf5-wasm

emmake make -C build -j$(nproc)
```

### 0.1.3 Source inventory

The build pulls in the following source lists. This inventory is used later to
verify that every compiled translation unit is accounted for.

**openEMS root** -- `vendor/openEMS/CMakeLists.txt` (line 161-163):

- `openems.cpp`

**FDTD** -- `vendor/openEMS/FDTD/CMakeLists.txt` (lines 10-30):

- `engine.cpp`, `operator.cpp`, `engine_multithread.cpp`,
  `operator_cylinder.cpp`, `engine_cylinder.cpp`, `engine_sse.cpp`,
  `operator_sse.cpp`, `operator_sse_compressed.cpp`,
  `engine_sse_compressed.cpp`, `operator_multithread.cpp`, `excitation.cpp`,
  `operator_cylindermultigrid.cpp`, `engine_cylindermultigrid.cpp`,
  `engine_interface_fdtd.cpp`, `engine_interface_sse_fdtd.cpp`,
  `engine_interface_cylindrical_fdtd.cpp`
- MPI-conditional (lines 3-7): `openems_fdtd_mpi.cpp`, `operator_mpi.cpp`,
  `engine_mpi.cpp`

**FDTD/extensions** -- `vendor/openEMS/FDTD/extensions/CMakeLists.txt` (lines 5-32):

- `engine_extension.cpp`, `operator_ext_dispersive.cpp`,
  `operator_ext_lorentzmaterial.cpp`, `operator_ext_conductingsheet.cpp`,
  `engine_ext_dispersive.cpp`, `engine_ext_lorentzmaterial.cpp`,
  `engine_ext_cylindermultigrid.cpp`, `operator_ext_upml.cpp`,
  `engine_ext_upml.cpp`, `operator_extension.cpp`, `engine_ext_mur_abc.cpp`,
  `operator_ext_mur_abc.cpp`, `operator_ext_cylinder.cpp`,
  `engine_ext_cylinder.cpp`, `operator_ext_excitation.cpp`,
  `engine_ext_excitation.cpp`, `operator_ext_tfsf.cpp`,
  `engine_ext_tfsf.cpp`, `operator_ext_steadystate.cpp`,
  `engine_ext_steadystate.cpp`, `operator_ext_lumpedRLC.cpp`,
  `engine_ext_lumpedRLC.cpp`, `operator_ext_absorbing_bc.cpp`,
  `engine_ext_absorbing_bc.cpp`

**Common** -- `vendor/openEMS/Common/CMakeLists.txt` (lines 4-18):

- `engine_interface_base.cpp`, `operator_base.cpp`, `processcurrent.cpp`,
  `processfieldprobe.cpp`, `processfields.cpp`, `processfields_fd.cpp`,
  `processfields_sar.cpp`, `processfields_td.cpp`, `processing.cpp`,
  `processintegral.cpp`, `processmodematch.cpp`, `processvoltage.cpp`

**Tools** -- `vendor/openEMS/tools/CMakeLists.txt` (lines 2-15):

- `AdrOp.cpp`, `ErrorMsg.cpp`, `array_ops.cpp`, `signal.cpp`, `global.cpp`,
  `hdf5_file_reader.cpp`, `hdf5_file_writer.cpp`, `sar_calculation.cpp`,
  `useful.cpp`, `vtk_file_writer.cpp`

**nf2ff** -- `vendor/openEMS/nf2ff/CMakeLists.txt` (lines 23-30):

- `nf2ff.cpp`, `nf2ff_calc.cpp`
- Re-uses from tools: `array_ops.cpp`, `useful.cpp`, `hdf5_file_reader.cpp`,
  `hdf5_file_writer.cpp`

**CSXCAD** -- `vendor/CSXCAD/src/CMakeLists.txt` (lines 45-85):

- `ContinuousStructure.cpp`, `CSPrimitives.cpp`, `CSProperties.cpp`,
  `CSRectGrid.cpp`, `ParameterObjects.cpp`, `CSFunctionParser.cpp`,
  `CSUseful.cpp`, `ParameterCoord.cpp`, `CSTransform.cpp`, `CSPrimPoint.cpp`,
  `CSPrimBox.cpp`, `CSPrimMultiBox.cpp`, `CSPrimSphere.cpp`,
  `CSPrimSphericalShell.cpp`, `CSPrimCylinder.cpp`,
  `CSPrimCylindricalShell.cpp`, `CSPrimPolygon.cpp`, `CSPrimLinPoly.cpp`,
  `CSPrimRotPoly.cpp`, `CSPrimPolyhedron.cpp`, `CSPrimPolyhedronReader.cpp`,
  `CSPrimCurve.cpp`, `CSPrimWire.cpp`, `CSPrimUserDefined.cpp`,
  `CSPropUnknown.cpp`, `CSPropMaterial.cpp`, `CSPropDispersiveMaterial.cpp`,
  `CSPropLorentzMaterial.cpp`, `CSPropDebyeMaterial.cpp`,
  `CSPropDiscMaterial.cpp`, `CSPropLumpedElement.cpp`,
  `CSPropAbsorbingBC.cpp`, `CSPropMetal.cpp`, `CSPropConductingSheet.cpp`,
  `CSPropExcitation.cpp`, `CSPropProbeBox.cpp`, `CSPropDumpBox.cpp`,
  `CSPropResBox.cpp`, `CSBackgroundMaterial.cpp`

### 0.1.4 Verification

```
cmake --build build 2>&1 | head -5
# Must print "Scanning dependencies" or similar -- no immediate CMake errors.
```

---

## 0.2 CGAL Disable Patch

CGAL is used only for polyhedron meshing primitives. It is extremely difficult to
cross-compile to WASM and is not needed for any antenna simulation geometry
(which uses boxes, cylinders, polygons, and curves). Disable it entirely.

### Files to modify

#### 1. `vendor/CSXCAD/CMakeLists.txt`

**Line 117** -- change `find_package(CGAL REQUIRED)` to conditional:

```cmake
# Was:
#   find_package(CGAL REQUIRED)

# Replace with:
option(DISABLE_CGAL "Disable CGAL dependency" OFF)
if (NOT DISABLE_CGAL)
  find_package(CGAL REQUIRED)
  INCLUDE_DIRECTORIES(${CGAL_INCLUDE_DIR})
  # ... keep existing CGAL version logic at lines 121-136 unchanged ...
else()
  message(STATUS "CGAL disabled -- polyhedron primitives will not be available")
  set(CSXCAD_CGAL_LIBRARIES "")
  add_definitions(-DCSXCAD_NO_CGAL)
endif()
```

**Line 118** -- guard `INCLUDE_DIRECTORIES(${CGAL_INCLUDE_DIR})` inside the
`if (NOT DISABLE_CGAL)` block (move it up into the block above).

**Lines 140-142** -- guard the `-frounding-math` flag (only needed for CGAL):

```cmake
# Was:
#   if (CMAKE_CXX_COMPILER_ID MATCHES "GNU")
#     set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -frounding-math")
#   endif()

# Replace with:
if (NOT DISABLE_CGAL)
  if (CMAKE_CXX_COMPILER_ID MATCHES "GNU")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -frounding-math")
  endif()
endif()
```

#### 2. `vendor/CSXCAD/src/CMakeLists.txt`

**Lines 65-66** -- conditionally exclude polyhedron sources:

```cmake
# After line 64 (CSPrimRotPoly.cpp), replace lines 65-66 with:
if (NOT DISABLE_CGAL)
  list(APPEND SOURCES CSPrimPolyhedron.cpp CSPrimPolyhedronReader.cpp)
endif()
```

Remove `CSPrimPolyhedron.cpp` and `CSPrimPolyhedronReader.cpp` from the
unconditional SOURCES list. Also remove `CSPrimPolyhedron.h` and
`CSPrimPolyhedronReader.h` from PUB_HEADERS (lines 24-25) conditionally:

```cmake
if (NOT DISABLE_CGAL)
  list(APPEND PUB_HEADERS CSPrimPolyhedron.h CSPrimPolyhedronReader.h)
endif()
```

**Line 95** -- the `${CSXCAD_CGAL_LIBRARIES}` link is already handled because
we set it to `""` when CGAL is disabled.

#### 3. `vendor/CSXCAD/src/ContinuousStructure.cpp`

**Lines 30-31** -- guard the includes:

```cpp
// Was:
//   #include "CSPrimPolyhedron.h"
//   #include "CSPrimPolyhedronReader.h"

// Replace with:
#ifndef CSXCAD_NO_CGAL
#include "CSPrimPolyhedron.h"
#include "CSPrimPolyhedronReader.h"
#endif
```

**Lines 620-621** -- guard the factory cases:

```cpp
// Was:
//   else if (strcmp(cPrim,"Polyhedron")==0) newPrim = new CSPrimPolyhedron(clParaSet,prop);
//   else if (strcmp(cPrim,"PolyhedronReader")==0) newPrim = new CSPrimPolyhedronReader(clParaSet,prop);

// Replace with:
#ifndef CSXCAD_NO_CGAL
        else if (strcmp(cPrim,"Polyhedron")==0) newPrim = new CSPrimPolyhedron(clParaSet,prop);
        else if (strcmp(cPrim,"PolyhedronReader")==0) newPrim = new CSPrimPolyhedronReader(clParaSet,prop);
#endif
```

### Verification

```bash
emcmake cmake -B build -S . -DDISABLE_CGAL=ON
# Must configure without errors and without "find_package(CGAL)" output.
grep -r "CSPrimPolyhedron" build/  # Should not appear in any generated makefiles.
```

---

## 0.3 VTK Disable Patch

VTK provides visualization output (rectilinear grid files, polydata). In the
WASM build we replace all VTK output with HDF5-only output. The VTK code is
guarded behind a preprocessor define `NO_VTK`.

### Files to modify in openEMS

#### 1. `vendor/openEMS/CMakeLists.txt`

**Lines 143-156** -- wrap the entire VTK find/include block:

```cmake
option(DISABLE_VTK "Disable VTK dependency" OFF)
if (NOT DISABLE_VTK)
  find_package(VTK COMPONENTS vtkCommonCore NO_MODULE QUIET)
  if ("${VTK_VERSION}" VERSION_GREATER "9")
      find_package(VTK REQUIRED COMPONENTS IOXML IOGeometry IOLegacy IOPLY NO_MODULE REQUIRED)
  else()
      find_package(VTK REQUIRED COMPONENTS vtkIOXML vtkIOGeometry vtkIOLegacy vtkIOPLY NO_MODULE REQUIRED)
      include(${VTK_USE_FILE})
  endif()
  message(STATUS "Found package VTK. Using version " ${VTK_VERSION})
  set( vtk_LIBS ${VTK_LIBRARIES} )
  INCLUDE_DIRECTORIES (${VTK_INCLUDE_DIR})
else()
  message(STATUS "VTK disabled")
  set(vtk_LIBS "")
  add_definitions(-DNO_VTK)
endif()
```

#### 2. `vendor/openEMS/tools/vtk_file_writer.cpp`

**Lines 22-32** -- guard the VTK includes:

```cpp
#ifndef NO_VTK
#include <vtkRectilinearGrid.h>
#include <vtkRectilinearGridWriter.h>
#include <vtkXMLRectilinearGridWriter.h>
#include <vtkStructuredGrid.h>
#include <vtkStructuredGridWriter.h>
#include <vtkXMLStructuredGridWriter.h>
#include <vtkZLibDataCompressor.h>
#include <vtkFloatArray.h>
#include <vtkDoubleArray.h>
#include <vtkFieldData.h>
#include <vtkPointData.h>
#endif
```

The entire file body (class methods) must also be wrapped in `#ifndef NO_VTK`
/ `#endif`, or alternatively the file can be conditionally excluded from the
build in `vendor/openEMS/tools/CMakeLists.txt` line 13:

```cmake
if (NOT DISABLE_VTK)
  list(APPEND TOOL_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/vtk_file_writer.cpp)
endif()
```

The simpler approach is to guard the file contents. Either way, all callers
must also be guarded (see below).

#### 3. `vendor/openEMS/FDTD/operator.cpp`

**Lines 25, 29-32** -- guard VTK includes:

```cpp
// Line 25:
#ifndef NO_VTK
#include "tools/vtk_file_writer.h"
#endif

// Lines 29-32:
#ifndef NO_VTK
#include "vtkPolyData.h"
#include "vtkCellArray.h"
#include "vtkPoints.h"
#include "vtkXMLPolyDataWriter.h"
#endif
```

Additionally, search this file for all VTK API calls (e.g.,
`vtkSmartPointer`, `vtkPolyData`, `vtkPoints`, `vtkCellArray`,
`vtkXMLPolyDataWriter`) and wrap each usage block with `#ifndef NO_VTK` /
`#endif`. These are in the `Operator::CalcPEC()` debug dump method and
`Operator::DumpOperator2File()`.

#### 4. `vendor/openEMS/openems.cpp`

**Line 49** -- guard VTK version include:

```cpp
#ifndef NO_VTK
#include <vtkVersion.h>
#endif
```

Also guard any references to `VTK_VERSION` or `vtkVersion` used in the
welcome/version print routines later in the file.

#### 5. `vendor/openEMS/Common/processfields.cpp` (line 20)
#### 6. `vendor/openEMS/Common/processfields_fd.cpp` (line 20)
#### 7. `vendor/openEMS/Common/processfields_sar.cpp` (line 20)
#### 8. `vendor/openEMS/Common/processfields_td.cpp` (line 20)

All four files include `tools/vtk_file_writer.h`. Guard each:

```cpp
#ifndef NO_VTK
#include "tools/vtk_file_writer.h"
#endif
```

Then guard every method body that instantiates or calls `VTK_File_Writer`.
These are typically in `ProcessFields::InitProcess()` and the `*_TD`/`*_FD`
`DumpData` methods. Wrap each VTK code path with `#ifndef NO_VTK`.

### Files to modify in CSXCAD

#### 9. `vendor/CSXCAD/CMakeLists.txt`

**Lines 149-161** -- wrap the VTK block:

```cmake
option(DISABLE_VTK "Disable VTK dependency" OFF)
if (NOT DISABLE_VTK)
  find_package(VTK COMPONENTS vtkCommonCore NO_MODULE QUIET)
  # ... existing version logic ...
else()
  message(STATUS "VTK disabled for CSXCAD")
  set(vtk_LIBS "")
  add_definitions(-DNO_VTK)
endif()
```

#### 10. `vendor/CSXCAD/src/CSPrimPolyhedronReader.cpp` (lines 24-27)

Already excluded by the CGAL disable patch (section 0.2). No additional
changes needed if CGAL is disabled. If built with CGAL but without VTK,
guard the includes:

```cpp
#ifndef NO_VTK
#include <vtkSTLReader.h>
#include <vtkPLYReader.h>
#include <vtkPolyData.h>
#include <vtkCellArray.h>
#endif
```

#### 11. `vendor/CSXCAD/src/CSPropDiscMaterial.cpp` (lines 22-24)

```cpp
#ifndef NO_VTK
#include "vtkPolyData.h"
#include "vtkCellArray.h"
#include "vtkPoints.h"
#endif
```

Guard all VTK API calls in the file body (used in
`CSPropDiscMaterial::ReadHDF5()` for mesh loading).

#### 12. `vendor/CSXCAD/src/CSTransform.cpp` (line 26)

```cpp
#ifndef NO_VTK
#include "vtkMatrix4x4.h"
#endif
```

Guard the `GetMatrix4x4()` method or replace it with a simple 4x4 matrix
implementation (16-element double array with manual multiply). CSTransform
only uses `vtkMatrix4x4` for a convenience method; it is not critical path.

### Verification

```bash
emcmake cmake -B build -S . -DDISABLE_VTK=ON -DDISABLE_CGAL=ON
emmake make -C build 2>&1 | grep -i vtk
# Must produce zero VTK-related compiler errors.
```

---

## 0.4 Boost Subset for Emscripten

openEMS uses the following Boost components (see `vendor/openEMS/CMakeLists.txt`
lines 126-133):

- `thread`
- `date_time`
- `serialization`
- `chrono`
- `program_options`

For the WASM build, `thread` is the most important (used by the multithread
engine). `program_options` is addressed separately in section 0.6.

### Strategy

Build Boost from source with Emscripten using `b2`:

```bash
cd boost_1_84_0
./bootstrap.sh
echo "using emscripten : : em++ ;" > user-config.jam
./b2 --user-config=user-config.jam \
     toolset=emscripten \
     link=static \
     threading=single \
     --with-thread \
     --with-date_time \
     --with-serialization \
     --with-chrono \
     --with-system \
     --with-program_options \
     --prefix=$PWD/../deps/boost-wasm \
     install
```

Set `-DBoost_ROOT=$PWD/deps/boost-wasm` in the CMake invocation.

### Threading note

`boost::thread` in Emscripten requires `-pthread` flag and
`SharedArrayBuffer`. Add to the root CMakeLists:

```cmake
if (WASM_BUILD)
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -pthread")
  set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -pthread -sPTHREAD_POOL_SIZE=4")
endif()
```

### Verification

```bash
ls deps/boost-wasm/lib/libboost_thread.a
# Must exist.
```

---

## 0.5 HDF5 and TinyXML for Emscripten

### HDF5

HDF5 is used for all field dump I/O. Build the C library (no C++, no Fortran)
with Emscripten:

```bash
cd hdf5-1.14.3
emcmake cmake -B build \
  -DCMAKE_INSTALL_PREFIX=$PWD/../deps/hdf5-wasm \
  -DBUILD_SHARED_LIBS=OFF \
  -DHDF5_BUILD_TOOLS=OFF \
  -DHDF5_BUILD_EXAMPLES=OFF \
  -DHDF5_BUILD_HL_LIB=ON \
  -DHDF5_ENABLE_Z_LIB_SUPPORT=OFF \
  -DHDF5_ENABLE_SZIP_SUPPORT=OFF
emmake make -C build -j$(nproc) install
```

Set `-DHDF5_ROOT=$PWD/deps/hdf5-wasm` in the CMake invocation.

### TinyXML

TinyXML is a single `.cpp`/`.h` pair. Compile it directly:

```bash
em++ -c -O2 -DTIXML_USE_STL tinyxml.cpp tinystr.cpp tinyxmlerror.cpp tinyxmlparser.cpp
emar rcs libtinyxml.a tinyxml.o tinystr.o tinyxmlerror.o tinyxmlparser.o
```

Set `-DTinyXML_ROOT_DIR=$PWD/deps/tinyxml` in the CMake invocation.

### fparser

fparser (function parser) is also a small library. Compile with Emscripten:

```bash
em++ -c -O2 fparser.cc fpoptimizer.cc
emar rcs libfparser.a fparser.o fpoptimizer.o
```

### Verification

```bash
file deps/hdf5-wasm/lib/libhdf5.a    # Must show "LLVM bitcode" or "WebAssembly"
file deps/tinyxml/libtinyxml.a
```

---

## 0.6 Specific Blockers

### 0.6.1 `setlocale()` calls

`setlocale()` is available in Emscripten but does nothing useful. The calls are
harmless but should be noted. If they cause link errors in a future minimal
libc configuration, wrap them.

**Locations:**

| File | Line | Call |
|------|------|------|
| `vendor/openEMS/openems.cpp` | 70 | `setlocale(LC_NUMERIC, "en_US.UTF-8");` |
| `vendor/openEMS/FDTD/extensions/operator_ext_upml.cpp` | 27 | `setlocale(LC_NUMERIC, "en_US.UTF-8");` |

**Action:** No change required for initial build. If link errors occur, add:

```cpp
#ifdef __EMSCRIPTEN__
// setlocale is a no-op in Emscripten
#else
setlocale(LC_NUMERIC, "en_US.UTF-8");
#endif
```

### 0.6.2 Denormal FPU control (SSE intrinsics)

**File:** `vendor/openEMS/tools/denormal.h` (lines 19-30)

The code uses `_mm_getcsr()` and `_mm_setcsr()` which are x86-only SSE
intrinsics. These are **already guarded** by `#if BOOST_ARCH_X86` (lines 3, 21).
On Emscripten (which defines neither `BOOST_ARCH_X86` nor provides
`<xmmintrin.h>`), the guard evaluates to false and the function body is empty.

**Action:** No change required. Verify with:

```bash
grep -n "BOOST_ARCH_X86" vendor/openEMS/tools/denormal.h
# Should show lines 3 and 21.
```

### 0.6.3 `exit()` calls

There are 51 `exit()` calls across 11 files. In a WASM module, `exit()` tears
down the entire runtime. These must be replaced with exceptions or error-return
codes.

**Full inventory:**

| File | Count | Lines (approximate) |
|------|-------|---------------------|
| `vendor/openEMS/tools/ErrorMsg.cpp` | 7 | Various `exit(-1)` in error handlers |
| `vendor/openEMS/tools/AdrOp.cpp` | 4 | Array bounds errors |
| `vendor/openEMS/tools/array_ops.cpp` | 5 | Allocation failures |
| `vendor/openEMS/tools/vtk_file_writer.cpp` | 2 | Write failures |
| `vendor/openEMS/tools/sar_calculation.cpp` | 2 | Validation errors |
| `vendor/openEMS/FDTD/operator.cpp` | 3 | Setup failures |
| `vendor/openEMS/FDTD/engine_interface_fdtd.cpp` | 2 | Invalid state |
| `vendor/openEMS/FDTD/openems_fdtd_mpi.cpp` | 3 | MPI errors (excluded from WASM build) |
| `vendor/openEMS/openems.cpp` | 2 | `std::exit(0)` in help handler (line 156), fatal errors |
| `vendor/openEMS/main.cpp` | 4 | Lines 58, 66, 69, 77 |
| `vendor/openEMS/nf2ff/main.cpp` | 1 | Argument error |

**Strategy:** Define a custom exception class and replace `exit()` calls:

```cpp
// New file: vendor/openEMS/tools/wasm_compat.h
#ifndef WASM_COMPAT_H
#define WASM_COMPAT_H

#include <stdexcept>

#ifdef __EMSCRIPTEN__
class openems_fatal : public std::runtime_error {
public:
    int code;
    openems_fatal(int c, const char* msg = "")
        : std::runtime_error(msg), code(c) {}
};
#define OPENEMS_EXIT(code) throw openems_fatal(code, "openEMS fatal error")
#else
#define OPENEMS_EXIT(code) exit(code)
#endif

#endif
```

Then in each file, include `tools/wasm_compat.h` and replace `exit(N)` with
`OPENEMS_EXIT(N)`. Note: `main.cpp` and `nf2ff/main.cpp` will not be compiled
in the WASM build (we expose a library API instead), so their `exit()` calls
can be ignored.

**Priority files** (non-main, non-MPI):

1. `tools/ErrorMsg.cpp` -- 7 replacements
2. `tools/AdrOp.cpp` -- 4 replacements
3. `tools/array_ops.cpp` -- 5 replacements
4. `tools/vtk_file_writer.cpp` -- 2 replacements (may be excluded by VTK disable)
5. `tools/sar_calculation.cpp` -- 2 replacements
6. `FDTD/operator.cpp` -- 3 replacements
7. `FDTD/engine_interface_fdtd.cpp` -- 2 replacements
8. `openems.cpp` -- 2 replacements

### 0.6.4 `boost::program_options` replacement

This is the **heaviest single blocker**. `boost::program_options` is deeply
integrated into the option-handling infrastructure.

**Affected files:**

| File | Lines | Usage |
|------|-------|-------|
| `vendor/openEMS/tools/global.h` | 23, 84, 88, 121, 130-131 | `#include <boost/program_options.hpp>`, `options_description`, `variables_map`, `variable_value` types in class definition |
| `vendor/openEMS/tools/global.cpp` | 24, 38-87, 89-101, 103-127, 129-162, 164-167, 169-180, 182-185 | Full `namespace po = boost::program_options;` usage, option registration with notifier lambdas, command-line parsing |
| `vendor/openEMS/openems.cpp` | 59, 144-310+ | `namespace po = boost::program_options;`, `openEMS::optionDesc()` method defining ~15 options with `po::bool_switch()`, `po::value<>`, and `->notifier()` lambdas |

**Three possible strategies (choose one):**

**(a) Compile Boost.ProgramOptions to WASM** (recommended for Phase 0)

This is the simplest path. Boost.ProgramOptions compiles cleanly with
Emscripten. Include it in the Boost cross-compilation step (section 0.4).
No source changes needed.

**(b) Stub with a minimal parser**

Replace `boost::program_options` with a thin wrapper that stores key-value
pairs and invokes notifier callbacks. This requires rewriting `global.h`,
`global.cpp`, and the `openEMS::optionDesc()` method. Estimated: ~300 lines
of new code.

**(c) Hardcode options via Embind**

For the WASM API, options are set programmatically (not via command line).
Replace the entire option infrastructure with direct setter methods on the
`openEMS` class. This is the cleanest long-term solution but requires the
most refactoring.

**Recommendation:** Use strategy (a) for Phase 0 to unblock the build. Switch
to strategy (c) in a later phase when designing the JS API.

### Verification

```bash
# After all 0.6 changes:
emmake make -C build 2>&1 | grep -c "error:"
# Must be 0.
```

---

## 0.7 Static Library Build Target

The native build produces a shared library (`libopenEMS.so`) and an executable
(`openEMS_bin`). For WASM we need a static library that can be linked into a
single `.wasm` module.

### Changes to `vendor/openEMS/CMakeLists.txt`

**Line 183** -- make library type conditional:

```cmake
# Was:
#   add_library( openEMS SHARED ${SOURCES})

# Replace with:
if (WASM_BUILD)
  add_library( openEMS STATIC ${SOURCES})
else()
  add_library( openEMS SHARED ${SOURCES})
endif()
```

**Lines 203-205** -- skip the executable target for WASM:

```cmake
if (NOT WASM_BUILD)
  ADD_EXECUTABLE( openEMS_bin main.cpp )
  SET_TARGET_PROPERTIES(openEMS_bin PROPERTIES OUTPUT_NAME openEMS)
  TARGET_LINK_LIBRARIES(openEMS_bin openEMS)
endif()
```

### Changes to `vendor/CSXCAD/src/CMakeLists.txt`

**Line 88** -- make library type conditional:

```cmake
if (WASM_BUILD)
  add_library( CSXCAD STATIC ${SOURCES} )
else()
  add_library( CSXCAD SHARED ${SOURCES} )
endif()
```

### Changes to `vendor/openEMS/nf2ff/CMakeLists.txt`

**Line 38** -- make library type conditional:

```cmake
if (WASM_BUILD)
  add_library( nf2ff STATIC ${SOURCES})
else()
  add_library( nf2ff SHARED ${SOURCES})
endif()
```

**Lines 52-54** -- skip executable:

```cmake
if (NOT WASM_BUILD)
  ADD_EXECUTABLE( nf2ff_bin main.cpp )
  SET_TARGET_PROPERTIES(nf2ff_bin PROPERTIES OUTPUT_NAME nf2ff)
  TARGET_LINK_LIBRARIES(nf2ff_bin nf2ff)
endif()
```

### Verification

```bash
file build/vendor/openEMS/libopenEMS.a
# Must show static archive (LLVM bitcode or WebAssembly object).
```

---

## 0.8 Reference Fixtures

Before modifying any simulation code, capture reference output from a native
(x86) build. These fixtures are used in later phases to verify correctness of
the WASM port.

### Test case 1: Rectangular cavity resonator

- Geometry: PEC box, 5 cm x 2 cm x 6 cm
- Excitation: Gaussian pulse, 1-10 GHz
- Timesteps: 20,000
- Boundary conditions: all PEC (6x PEC)
- Expected resonances: TE101 = 3.247 GHz, TE102 = 5.204 GHz, TE201 = 5.590 GHz
  (from analytical formula `f_mnp = c/(2*pi) * sqrt((m*pi/a)^2 + (n*pi/b)^2 + (p*pi/d)^2)`)
- Output: voltage probe at center of cavity

### Test case 2: Coaxial transmission line

- Geometry: coaxial, r_inner = 100 mm, r_outer = 230 mm, length = 1000 mm
- Mesh: 5 mm resolution
- Excitation: Gaussian pulse, 0-1 GHz
- Boundary conditions: PML on z-max, PEC elsewhere
- Expected: Z0 ~= 50 Ohm (from `Z0 = 60 * ln(r_o/r_i)`)
- Output: voltage and current probes at z = 250 mm, z = 750 mm

### Test case 3: Field probes (infinitesimal dipole)

- Geometry: infinitesimal dipole, lambda/50 length at 1 GHz
- Mesh: lambda/20 cells
- Boundary conditions: Mur ABC
- Timesteps: 10,000
- Output: E-field and H-field probes at 3 distances in 3 directions

### Output format

Run each test case natively and package results as JSON fixtures:

```
tests/fixtures/
  cavity/
    probe_voltage.csv      # raw probe data
    reference.json         # { "resonances_ghz": [3.247, 5.204, 5.590], "tolerance_pct": 1.0 }
  coax/
    probe_voltage_z250.csv
    probe_current_z250.csv
    probe_voltage_z750.csv
    probe_current_z750.csv
    reference.json         # { "z0_ohm": 50.0, "tolerance_pct": 2.0 }
  dipole/
    probe_e_*.csv
    probe_h_*.csv
    reference.json         # analytical near-field values
```

### Build and run natively

```bash
# Native build (not Emscripten)
cmake -B build-native -S vendor/openEMS -DCMAKE_BUILD_TYPE=Release
make -C build-native -j$(nproc)

# Run each test (scripts to be written in tests/generate_fixtures.py)
./build-native/openEMS tests/cavity.xml
./build-native/openEMS tests/coax.xml
./build-native/openEMS tests/dipole.xml
```

### Verification

```bash
ls tests/fixtures/cavity/reference.json
ls tests/fixtures/coax/reference.json
ls tests/fixtures/dipole/reference.json
# All must exist with non-empty content.
```

---

## CGAL Rounding-Mode Constraint

CGAL's interval arithmetic relies on hardware FP rounding mode switching (round toward +inf/-inf) to bound errors in geometric predicates. WASM only supports round-to-nearest-even with no mechanism to change rounding modes. Without correct rounding, CGAL's standard kernels can produce incorrect geometry: crashing predicates, non-physical intersections, or non-watertight meshes.

**Chosen mitigation:** Disable CGAL entirely via `-DCSXCAD_NO_CGAL` (section 0.2). This is a ~20-line conditional compilation patch.

**Geometry features lost:** `CSPrimPolyhedron` (point-in-polyhedron via AABB tree ray casting) and `CSPrimPolyhedronReader` (STL/PLY import). All simpler primitives (boxes, cylinders, spheres, polygons, curves, wires) remain available. Most antenna simulations do not require polyhedra.

**Alternative paths (not taken for MVP):** Software rounding emulation via `nextafter()`, exact constructions kernel (`Exact_predicates_exact_constructions_kernel`), or CGAL rounding-mode-free static-filter predicates. These could be revisited if polyhedron support is required later.

---

## Risk Register

| Risk | Mitigation | Verification |
|------|------------|--------------|
| CGAL rounding-mode correctness | Disabled via `-DCSXCAD_NO_CGAL`; polyhedron primitives excluded | Build completes without CGAL; no `CSPrimPolyhedron` in generated makefiles |
| FP determinism (transcendentals) | Cross-verify WASM output against native reference fixtures | Phase 1 WASM-vs-native tolerance tests pass |
| Browser memory limits (4 GB wasm32) | Memory64 flag for large grids; enforce grid size limits in API | Grid size validation in setup; memory64 build tested |

---

## Summary checklist

| Step | Description | Key files | Blocked by |
|------|-------------|-----------|------------|
| 0.1 | Root CMakeLists + emcmake invocation | `CMakeLists.txt` (new) | Nothing |
| 0.2 | CGAL disable | `vendor/CSXCAD/CMakeLists.txt`, `src/CMakeLists.txt`, `ContinuousStructure.cpp` | 0.1 |
| 0.3 | VTK disable | 12 files (see above) | 0.1 |
| 0.4 | Boost for Emscripten | External build | 0.1 |
| 0.5 | HDF5, TinyXML, fparser for Emscripten | External builds | 0.1 |
| 0.6 | exit(), setlocale, denormal, program_options | `tools/global.h`, `global.cpp`, `openems.cpp`, 8+ files | 0.1 |
| 0.7 | Static library targets | 3 CMakeLists.txt files | 0.2, 0.3 |
| 0.8 | Reference fixtures | Test XML files + scripts | Native build only |

Steps 0.2, 0.3, 0.4, 0.5, and 0.6 can proceed in parallel after 0.1 is done.
Step 0.7 depends on 0.2 and 0.3. Step 0.8 is independent (uses native build).
