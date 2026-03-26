#!/usr/bin/env bash
set -euo pipefail

# Build openEMS with memory64 (wasm64) support.
# Requires: all dependencies rebuilt as wasm64.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="$ROOT/deps/wasm64"
BUILD="$ROOT/build-wasm64"

mkdir -p "$PREFIX"/{lib,include}

NPROC=$(sysctl -n hw.logicalcpu 2>/dev/null || nproc 2>/dev/null || echo 4)
MEMORY64_FLAGS="-sMEMORY64=1"

echo "=== Building wasm64 dependencies ==="

# Copy headers from wasm32 build (they're the same)
if [ -d "$ROOT/deps/wasm/include" ]; then
  cp -r "$ROOT/deps/wasm/include/"* "$PREFIX/include/" 2>/dev/null || true
fi

# TinyXML
if [ ! -f "$PREFIX/lib/libtinyxml.a" ]; then
  echo "--- TinyXML (wasm64) ---"
  cd "$ROOT/deps/src/tinyxml"
  em++ -O2 -DTIXML_USE_STL $MEMORY64_FLAGS -c tinyxml.cpp tinystr.cpp tinyxmlerror.cpp tinyxmlparser.cpp
  emar rcs libtinyxml.a tinyxml.o tinystr.o tinyxmlerror.o tinyxmlparser.o
  cp libtinyxml.a "$PREFIX/lib/"
  cp tinyxml.h tinystr.h "$PREFIX/include/"
  rm -f *.o
fi

# fparser
if [ ! -f "$PREFIX/lib/libfparser.a" ]; then
  echo "--- fparser (wasm64) ---"
  cd "$ROOT/deps/src/fparser"
  em++ -O2 $MEMORY64_FLAGS -c fparser.cc fpoptimizer.cc 2>&1 | tail -3
  emar rcs libfparser.a fparser.o fpoptimizer.o
  cp libfparser.a "$PREFIX/lib/"
  mkdir -p "$PREFIX/include/fparser"
  cp fparser.hh "$PREFIX/include/"
  cp fparser.hh fpconfig.hh "$PREFIX/include/fparser/" 2>/dev/null || true
  rm -f *.o
fi

# HDF5
HDF5_DIR="$ROOT/deps/src/hdf5-1.14.6"
if [ ! -f "$PREFIX/lib/libhdf5.a" ]; then
  echo "--- HDF5 (wasm64) ---"
  WASM_BUILD="$HDF5_DIR/build-wasm64"
  NATIVE_BUILD="$HDF5_DIR/build-native"

  emcmake cmake -B "$WASM_BUILD" -S "$HDF5_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DBUILD_SHARED_LIBS=OFF \
    -DHDF5_BUILD_TOOLS=OFF \
    -DHDF5_BUILD_EXAMPLES=OFF \
    -DHDF5_BUILD_TESTING=OFF \
    -DHDF5_ENABLE_Z_LIB_SUPPORT=OFF \
    -DHDF5_ENABLE_SZIP_SUPPORT=OFF \
    -DHDF5_BUILD_HL_LIB=ON \
    -DHDF5_ENABLE_THREADSAFE=OFF \
    -DBUILD_TESTING=OFF \
    -DCMAKE_CROSSCOMPILING=ON \
    -DCMAKE_CROSSCOMPILING_EMULATOR="node" \
    -DHDF5_GENERATED_SOURCE_DIR="$NATIVE_BUILD/src" \
    -DCMAKE_C_FLAGS="-DFE_INVALID=0 -DFE_OVERFLOW=0 -DFE_UNDERFLOW=0 $MEMORY64_FLAGS" \
    -DCMAKE_CXX_FLAGS="$MEMORY64_FLAGS"

  emmake cmake --build "$WASM_BUILD" -j"$NPROC" 2>&1 | tail -5 || true
  cmake --install "$WASM_BUILD" 2>/dev/null || {
    find "$WASM_BUILD" -name "libhdf5*.a" -exec cp {} "$PREFIX/lib/" \;
    cp "$HDF5_DIR/src/"*.h "$PREFIX/include/" 2>/dev/null || true
    find "$WASM_BUILD/src" -name "H5pubconf.h" -exec cp {} "$PREFIX/include/" \; 2>/dev/null || true
    cp -r "$HDF5_DIR/hl/src/"*.h "$PREFIX/include/" 2>/dev/null || true
  }
fi

# Boost
BOOST_DIR="$ROOT/deps/src/boost_1_86_0"
if [ ! -f "$PREFIX/lib/libboost_thread.a" ]; then
  echo "--- Boost (wasm64) ---"
  cd "$BOOST_DIR"

  cat > user-config-wasm64.jam << JAMEOF
using gcc : emscripten64 : em++
  : <compileflags>-pthread
    <compileflags>-sMEMORY64=1
    <linkflags>-pthread
    <linkflags>-sMEMORY64=1
    <archiver>emar
    <ranlib>emranlib
;
JAMEOF

  ./b2 --user-config=user-config-wasm64.jam \
    toolset=gcc-emscripten64 \
    link=static \
    threading=multi \
    variant=release \
    cxxflags="-std=c++11" \
    --with-thread \
    --with-date_time \
    --with-serialization \
    --with-chrono \
    --with-system \
    --with-program_options \
    --prefix="$PREFIX" \
    -j"$NPROC" \
    install 2>&1 | tail -10
fi

echo ""
echo "=== wasm64 dependency check ==="
for lib in libtinyxml.a libfparser.a libhdf5.a libhdf5_hl.a libboost_thread.a libboost_program_options.a; do
  if [ -f "$PREFIX/lib/$lib" ]; then
    echo "  [OK] $lib"
  else
    echo "  [MISSING] $lib"
  fi
done

echo ""
echo "=== Building openEMS wasm64 ==="

emcmake cmake -B "$BUILD" -S "$ROOT" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_POLICY_DEFAULT_CMP0074=NEW \
  -DCMAKE_POLICY_DEFAULT_CMP0167=OLD \
  -DDISABLE_VTK=ON \
  -DDISABLE_CGAL=ON \
  -DDISABLE_MPI=ON \
  -DENABLE_MEMORY64=ON \
  -DFPARSER_ROOT_DIR="$PREFIX" \
  -DTinyXML_INCLUDE_DIR="$PREFIX/include" \
  -DTinyXML_LIBRARY="$PREFIX/lib/libtinyxml.a" \
  -DHDF5_ROOT="$PREFIX" \
  -DHDF5_USE_STATIC_LIBRARIES=ON \
  -DBoost_ROOT="$PREFIX" \
  -DBoost_NO_SYSTEM_PATHS=ON \
  -DBoost_USE_STATIC_LIBS=ON \
  -DBoost_NO_BOOST_CMAKE=ON \
  -DCMAKE_FIND_ROOT_PATH="$PREFIX" \
  -DCMAKE_PREFIX_PATH="$PREFIX" \
  -DCMAKE_SIZEOF_VOID_P=8

emmake cmake --build "$BUILD" -j"$NPROC" 2>&1

echo ""
if [ -f "$BUILD/openems.js" ] && [ -f "$BUILD/openems.wasm" ]; then
  echo "wasm64 build successful:"
  ls -lh "$BUILD/openems.js" "$BUILD/openems.wasm"
else
  echo "ERROR: wasm64 build failed"
  exit 1
fi
