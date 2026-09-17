# =============================================================================
# Alfred companion — ESP-IDF project-level CMake
# =============================================================================
#
# This is the top-level project file. The actual sources are registered as a
# single IDF "main" component in src/CMakeLists.txt. PlatformIO drives this via
# `framework = espidf`, but the project must also build with a bare
# `idf.py build` from this directory.
# =============================================================================

cmake_minimum_required(VERSION 3.16)

# Pull in the ESP-IDF build system. IDF_PATH is exported by the IDF/PlatformIO
# environment.
include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(companion)
