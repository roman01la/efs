cmake_minimum_required(VERSION 3.13)
project(antenna-prop)

option(DISABLE_VTK  "Strip all VTK dependencies"    OFF)
option(DISABLE_CGAL "Strip CGAL (polyhedron prims)"  OFF)
option(DISABLE_MPI  "Strip MPI support"              OFF)

set(WITH_MPI OFF CACHE BOOL "" FORCE)

option(ENABLE_MEMORY64 "Build with wasm64 (memory64) support" OFF)

if (EMSCRIPTEN)
  set(DISABLE_VTK ON CACHE BOOL "" FORCE)
  set(DISABLE_CGAL ON CACHE BOOL "" FORCE)
  set(DISABLE_MPI ON CACHE BOOL "" FORCE)
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -pthread -msimd128 -O3 -flto")
  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -pthread -msimd128 -O3 -flto")
  set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -O3 -flto")
  if (ENABLE_MEMORY64)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -sMEMORY64=1")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -sMEMORY64=1")
  endif()
endif()

add_subdirectory(vendor/CSXCAD)
add_subdirectory(vendor/openEMS)

if (EMSCRIPTEN)
  add_executable(openems_wasm src/embind_api.cpp src/csxcad_bindings.cpp)
  target_link_libraries(openems_wasm
    openEMS
    CSXCAD
    ${fparser_LIBRARIES}
    ${TinyXML_LIBRARY}
    ${HDF5_LIBRARIES}
    ${HDF5_HL_LIBRARIES}
    ${Boost_LIBRARIES}
  )
  target_include_directories(openems_wasm PRIVATE
    ${CMAKE_SOURCE_DIR}/vendor/openEMS
    ${CMAKE_SOURCE_DIR}/vendor/CSXCAD/src
    ${Boost_INCLUDE_DIRS}
    ${HDF5_INCLUDE_DIRS}
    ${TinyXML_INCLUDE_DIR}
    ${FPARSER_ROOT_DIR}/include
  )
  target_compile_definitions(openems_wasm PRIVATE TIXML_USE_STL)
  set_target_properties(openems_wasm PROPERTIES
    OUTPUT_NAME "openems"
    SUFFIX ".js"
  )
  target_link_options(openems_wasm PRIVATE
    "--bind"
    "-lembind"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sFORCE_FILESYSTEM=1"
    "-sEXPORTED_RUNTIME_METHODS=FS,HEAPF32"
    "-sEXPORTED_FUNCTIONS=_malloc,_free"
    "-sMODULARIZE=1"
    "-sEXPORT_NAME=createOpenEMS"
    "-sINITIAL_MEMORY=67108864"
    "-sSTACK_SIZE=2097152"
    "-sNO_EXIT_RUNTIME=1"
    "-sDISABLE_EXCEPTION_CATCHING=0"
    "-sENVIRONMENT=web,node"
    "-sWASM_BIGINT"
    "-sASSERTIONS=0"
    "--closure=0"
    "-pthread"
    "-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency||4"
    "-sDEFAULT_PTHREAD_STACK_SIZE=2097152"
  )
  if (ENABLE_MEMORY64)
    target_link_options(openems_wasm PRIVATE
      "-sMEMORY64=1"
      "-sMAXIMUM_MEMORY=8589934592"
    )
  endif()
endif()
