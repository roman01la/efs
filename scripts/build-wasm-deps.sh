#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPS="$ROOT/deps"
SRC="$DEPS/src"
PREFIX="$DEPS/wasm"

mkdir -p "$SRC" "$PREFIX"/{lib,include}

NPROC=$(sysctl -n hw.logicalcpu 2>/dev/null || nproc 2>/dev/null || echo 4)

# ---------------------------------------------------------------------------
# 1. TinyXML (v1 — openEMS requires tinyxml, not tinyxml2)
# ---------------------------------------------------------------------------
TINYXML_VERSION="2.6.2"
TINYXML_DIR="$SRC/tinyxml"

if [ ! -f "$PREFIX/lib/libtinyxml.a" ]; then
  echo "=== Building TinyXML $TINYXML_VERSION ==="
  mkdir -p "$TINYXML_DIR"
  if [ ! -f "$TINYXML_DIR/tinyxml.cpp" ]; then
    curl -L "https://sourceforge.net/projects/tinyxml/files/tinyxml/${TINYXML_VERSION}/tinyxml_${TINYXML_VERSION//./_}.tar.gz/download" \
      -o "$SRC/tinyxml.tar.gz"
    tar xzf "$SRC/tinyxml.tar.gz" -C "$SRC"
  fi
  cd "$TINYXML_DIR"
  em++ -O2 -DTIXML_USE_STL -c tinyxml.cpp tinystr.cpp tinyxmlerror.cpp tinyxmlparser.cpp
  emar rcs libtinyxml.a tinyxml.o tinystr.o tinyxmlerror.o tinyxmlparser.o
  cp libtinyxml.a "$PREFIX/lib/"
  cp tinyxml.h tinystr.h "$PREFIX/include/"
  echo "=== TinyXML done ==="
else
  echo "=== TinyXML already built ==="
fi

# ---------------------------------------------------------------------------
# 2. fparser (function parser)
# ---------------------------------------------------------------------------
FPARSER_DIR="$SRC/fparser"

if [ ! -f "$PREFIX/lib/libfparser.a" ]; then
  echo "=== Building fparser ==="
  if [ ! -d "$FPARSER_DIR" ]; then
    mkdir -p "$FPARSER_DIR"
    curl -L "http://warp.povusers.org/FunctionParser/fparser4.5.2.zip" \
      -o "$SRC/fparser.zip"
    cd "$SRC"
    unzip -o fparser.zip -d fparser
  fi
  cd "$FPARSER_DIR"
  em++ -O2 -c fparser.cc fpoptimizer.cc
  emar rcs libfparser.a fparser.o fpoptimizer.o
  cp libfparser.a "$PREFIX/lib/"
  mkdir -p "$PREFIX/include/fparser"
  cp fparser.hh fparser_mpfr.hh fparser_gmpint.hh fpconfig.hh extrasrc/fpaux.hh "$PREFIX/include/fparser/" 2>/dev/null || true
  cp fparser.hh "$PREFIX/include/"
  echo "=== fparser done ==="
else
  echo "=== fparser already built ==="
fi

# ---------------------------------------------------------------------------
# 3. HDF5 (C library + HL)
# ---------------------------------------------------------------------------
HDF5_VERSION="1.14.6"
HDF5_TAG="hdf5_${HDF5_VERSION}"
HDF5_DIR="$SRC/hdf5-${HDF5_VERSION}"

if [ ! -f "$PREFIX/lib/libhdf5.a" ]; then
  echo "=== Building HDF5 $HDF5_VERSION ==="
  if [ ! -d "$HDF5_DIR" ]; then
    curl -L "https://github.com/HDFGroup/hdf5/releases/download/${HDF5_TAG}/hdf5-${HDF5_VERSION}.tar.gz" \
      -o "$SRC/hdf5.tar.gz"
    tar xzf "$SRC/hdf5.tar.gz" -C "$SRC"
  fi

  # HDF5 cross-compilation: build native tools first, then WASM
  NATIVE_BUILD="$HDF5_DIR/build-native"
  if [ ! -d "$NATIVE_BUILD" ]; then
    echo "--- Building HDF5 native (for cross-compile tools) ---"
    cmake -B "$NATIVE_BUILD" -S "$HDF5_DIR" \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DHDF5_BUILD_TOOLS=OFF \
      -DHDF5_BUILD_EXAMPLES=OFF \
      -DHDF5_BUILD_TESTING=OFF \
      -DHDF5_ENABLE_Z_LIB_SUPPORT=OFF \
      -DHDF5_ENABLE_SZIP_SUPPORT=OFF \
      -DHDF5_BUILD_HL_LIB=ON \
      -DBUILD_TESTING=OFF
    cmake --build "$NATIVE_BUILD" -j"$NPROC"
  fi

  # WASM build using native tools for cross-compilation
  WASM_BUILD="$HDF5_DIR/build-wasm"
  echo "--- Building HDF5 for WASM ---"
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
    -DCMAKE_C_FLAGS="-DFE_INVALID=0 -DFE_OVERFLOW=0 -DFE_UNDERFLOW=0"

  emmake cmake --build "$WASM_BUILD" -j"$NPROC" 2>&1 | tail -20 || {
    echo "WARNING: HDF5 WASM build had errors"
  }

  # Install
  cmake --install "$WASM_BUILD" 2>/dev/null || {
    echo "--- Manual HDF5 install ---"
    find "$WASM_BUILD" -name "libhdf5*.a" -exec cp {} "$PREFIX/lib/" \;
    mkdir -p "$PREFIX/include"
    cp "$HDF5_DIR/src/"*.h "$PREFIX/include/" 2>/dev/null || true
    find "$WASM_BUILD/src" -name "H5pubconf.h" -exec cp {} "$PREFIX/include/" \; 2>/dev/null || true
    cp -r "$HDF5_DIR/hl/src/"*.h "$PREFIX/include/" 2>/dev/null || true
  }
  echo "=== HDF5 done ==="
else
  echo "=== HDF5 already built ==="
fi

# ---------------------------------------------------------------------------
# 4. Boost (subset needed by openEMS)
# ---------------------------------------------------------------------------
BOOST_VERSION="1.86.0"
BOOST_VERSION_UNDERSCORE="${BOOST_VERSION//./_}"
BOOST_DIR="$SRC/boost_${BOOST_VERSION_UNDERSCORE}"

if [ ! -f "$PREFIX/lib/libboost_thread.a" ]; then
  echo "=== Building Boost $BOOST_VERSION ==="
  if [ ! -d "$BOOST_DIR" ]; then
    curl -L "https://archives.boost.io/release/${BOOST_VERSION}/source/boost_${BOOST_VERSION_UNDERSCORE}.tar.gz" \
      -o "$SRC/boost.tar.gz"
    tar xzf "$SRC/boost.tar.gz" -C "$SRC"
  fi
  cd "$BOOST_DIR"

  if [ ! -f ./b2 ]; then
    ./bootstrap.sh
  fi

  # Boost's b2 doesn't have a built-in emscripten toolset.
  # Use the gcc toolset with em++ as the compiler.
  cat > user-config.jam << JAMEOF
using gcc : emscripten : em++
  : <compileflags>-pthread
    <linkflags>-pthread
    <archiver>emar
    <ranlib>emranlib
;
JAMEOF

  ./b2 --user-config=user-config.jam \
    toolset=gcc-emscripten \
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
    install 2>&1 | tail -30

  echo "=== Boost done ==="
else
  echo "=== Boost already built ==="
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Dependency build summary ==="
echo "PREFIX: $PREFIX"
echo ""
for lib in libtinyxml.a libfparser.a libhdf5.a libhdf5_hl.a libboost_thread.a libboost_program_options.a; do
  if [ -f "$PREFIX/lib/$lib" ]; then
    echo "  [OK] $lib"
  else
    echo "  [MISSING] $lib"
  fi
done
echo ""
echo "Include dirs:"
ls "$PREFIX/include/" | head -20
