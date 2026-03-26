#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPS="$ROOT/deps"
SRC="$DEPS/src"
PREFIX="$DEPS/native"

mkdir -p "$PREFIX"/{lib,include}

NPROC=$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4)

# TinyXML v1
TINYXML_DIR="$SRC/tinyxml"
if [ ! -f "$PREFIX/lib/libtinyxml.a" ]; then
  echo "=== Building TinyXML (native) ==="
  cd "$TINYXML_DIR"
  c++ -O2 -DTIXML_USE_STL -c tinyxml.cpp tinystr.cpp tinyxmlerror.cpp tinyxmlparser.cpp
  ar rcs libtinyxml.a tinyxml.o tinystr.o tinyxmlerror.o tinyxmlparser.o
  cp libtinyxml.a "$PREFIX/lib/"
  cp tinyxml.h tinystr.h "$PREFIX/include/"
  rm -f *.o
  echo "=== TinyXML done ==="
else
  echo "=== TinyXML already built ==="
fi

# fparser
FPARSER_DIR="$SRC/fparser"
if [ ! -f "$PREFIX/lib/libfparser.a" ]; then
  echo "=== Building fparser (native) ==="
  cd "$FPARSER_DIR"
  c++ -O2 -c fparser.cc fpoptimizer.cc
  ar rcs libfparser.a fparser.o fpoptimizer.o
  cp libfparser.a "$PREFIX/lib/"
  mkdir -p "$PREFIX/include/fparser"
  cp fparser.hh "$PREFIX/include/"
  cp fparser.hh fpconfig.hh "$PREFIX/include/fparser/"
  rm -f *.o
  echo "=== fparser done ==="
else
  echo "=== fparser already built ==="
fi

echo ""
echo "Native deps installed to: $PREFIX"
ls -la "$PREFIX/lib/"
