cmake_minimum_required(VERSION 3.13)
project(antenna-prop)

option(DISABLE_VTK  "Strip all VTK dependencies"    OFF)
option(DISABLE_CGAL "Strip CGAL (polyhedron prims)"  OFF)
option(DISABLE_MPI  "Strip MPI support"              OFF)

set(WITH_MPI OFF CACHE BOOL "" FORCE)

if (EMSCRIPTEN)
  set(DISABLE_VTK ON CACHE BOOL "" FORCE)
  set(DISABLE_CGAL ON CACHE BOOL "" FORCE)
  set(DISABLE_MPI ON CACHE BOOL "" FORCE)
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -pthread")
  set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -pthread -sPTHREAD_POOL_SIZE=4")
endif()

add_subdirectory(vendor/CSXCAD)
add_subdirectory(vendor/openEMS)

if (EMSCRIPTEN)
  add_executable(openems_wasm src/embind_api.cpp)
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
  )
  set_target_properties(openems_wasm PROPERTIES
    OUTPUT_NAME "openems"
    SUFFIX ".js"
  )
  target_link_options(openems_wasm PRIVATE
    "--bind"
    "-lembind"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sFORCE_FILESYSTEM=1"
    "-sEXPORTED_RUNTIME_METHODS=FS"
    "-sMODULARIZE=1"
    "-sEXPORT_NAME=createOpenEMS"
    "-sINITIAL_MEMORY=67108864"
    "-sSTACK_SIZE=2097152"
    "-sNO_EXIT_RUNTIME=0"
    "-sENVIRONMENT=web,node"
    "-pthread"
    "-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency||4"
    "-sDEFAULT_PTHREAD_STACK_SIZE=2097152"
  )
endif()
