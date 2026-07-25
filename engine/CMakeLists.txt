cmake_minimum_required(VERSION 3.22)
project(hfta_engine LANGUAGES CXX VERSION 0.1.0)

# ---------------------------------------------------------------------------
# WALKING SKELETON BUILD
#
# Deliberately has ZERO external dependencies — no vcpkg, no libzmq, no gtest.
# It compiles with nothing but a C++20 compiler, which means you can prove the
# order book works before you spend an evening fighting package managers.
#
# The ZeroMQ gateway, tests and benchmarks are commented out at the bottom.
# Uncomment them as each phase lands.
# ---------------------------------------------------------------------------

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

# DETERMINISM: never -march=native (mirrored containers may land on different
# host CPUs) and never -ffast-math (it licenses arithmetic reordering).
set(HFTA_ARCH_BASELINE "x86-64-v2" CACHE STRING "ISA baseline for reproducible builds")

add_library(hfta_flags INTERFACE)
target_compile_options(hfta_flags INTERFACE
  -Wall -Wextra -Wpedantic -Wshadow -Wnon-virtual-dtor
  -Wcast-align -Wunused -Wnull-dereference -Werror=return-type
  $<$<CONFIG:Release,RelWithDebInfo>:-fno-omit-frame-pointer>
)

add_library(hfta_core
  src/order_book.cpp
  src/scenario_generator.cpp
  src/matching_engine.cpp
)
target_include_directories(hfta_core PUBLIC include)
target_link_libraries(hfta_core PUBLIC hfta_flags)

add_executable(hfta_skeleton src/main.cpp)
target_link_libraries(hfta_skeleton PRIVATE hfta_core)

# ---------------------------------------------------------------------------
# Later phases — uncomment as you build them.
# ---------------------------------------------------------------------------
# find_package(cppzmq CONFIG REQUIRED)
# find_package(spdlog CONFIG REQUIRED)
# add_library(hfta_ipc src/zmq_gateway.cpp src/codec.cpp)
# target_link_libraries(hfta_ipc PUBLIC hfta_core cppzmq spdlog::spdlog)
# add_executable(hfta_engine src/engine_main.cpp)
# target_link_libraries(hfta_engine PRIVATE hfta_ipc)
#
# find_package(GTest CONFIG REQUIRED)
# enable_testing()
# add_executable(hfta_tests
#   tests/test_order_book.cpp tests/test_tif.cpp tests/test_risk.cpp
#   tests/test_determinism.cpp tests/test_scenario.cpp)
# target_link_libraries(hfta_tests PRIVATE hfta_core GTest::gtest_main)
# include(GoogleTest)
# gtest_discover_tests(hfta_tests)