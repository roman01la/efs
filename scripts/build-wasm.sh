#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="$ROOT/deps/wasm"
BUILD="$ROOT/build-wasm"

emcmake cmake -B "$BUILD" -S "$ROOT" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_POLICY_DEFAULT_CMP0074=NEW \
  -DCMAKE_POLICY_DEFAULT_CMP0167=OLD \
  -DDISABLE_VTK=ON \
  -DDISABLE_CGAL=ON \
  -DDISABLE_MPI=ON \
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
  -DCMAKE_SIZEOF_VOID_P=4

emmake cmake --build "$BUILD" -j$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4) 2>&1

echo ""
if [ -f "$BUILD/openems.js" ] && [ -f "$BUILD/openems.wasm" ]; then
  echo "Build successful:"
  ls -lh "$BUILD/openems.js" "$BUILD/openems.wasm"
else
  echo "ERROR: Expected output files not found"
  ls "$BUILD"/*.js "$BUILD"/*.wasm 2>/dev/null || echo "No .js/.wasm files in $BUILD"
  exit 1
fi
