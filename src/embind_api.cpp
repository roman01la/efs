#include <emscripten/bind.h>
#include <fstream>
#include <sstream>
#include <dirent.h>
#include <string>
#include <vector>
#include "openems.h"
#include "FDTD/operator.h"

using namespace emscripten;

// Helper to access the protected FDTD_Op member of openEMS.
// We cannot modify vendor code, so we use a derived accessor class.
class openEMS_Accessor : public openEMS {
public:
    Operator* getFDTD_Op() const { return FDTD_Op; }
};

class OpenEMSWrapper {
public:
    OpenEMSWrapper() : ems_(new openEMS()) {}

    ~OpenEMSWrapper() {
        delete ems_;
    }

    void configure(int engineType, unsigned int numTimesteps, double endCriteria) {
        std::vector<std::string> args;
        switch (engineType) {
            case 0: args.push_back("engine=basic"); break;
            case 1: args.push_back("engine=sse"); break;
            case 2: args.push_back("engine=sse-compressed"); break;
            case 3: args.push_back("engine=multithreaded"); break;
            default: args.push_back("engine=basic"); break;
        }
        ems_->SetLibraryArguments(args);
        ems_->SetNumberOfTimeSteps(numTimesteps);
        ems_->SetEndCriteria(endCriteria);
    }

    bool loadXML(const std::string& xmlString) {
        std::string path = "/tmp/sim.xml";
        std::ofstream out(path);
        if (!out.is_open()) return false;
        out << xmlString;
        out.close();
        return ems_->ParseFDTDSetup(path);
    }

    int setup() {
        return ems_->SetupFDTD();
    }

    void run() {
        ems_->RunFDTD();
    }

    std::string readFile(const std::string& path) {
        std::ifstream in(path, std::ios::binary);
        if (!in.is_open()) return "";
        std::ostringstream ss;
        ss << in.rdbuf();
        return ss.str();
    }

    std::vector<std::string> listFiles(const std::string& dir) {
        std::vector<std::string> files;
        DIR* d = opendir(dir.c_str());
        if (!d) return files;
        struct dirent* entry;
        while ((entry = readdir(d)) != nullptr) {
            std::string name(entry->d_name);
            if (name != "." && name != "..") {
                files.push_back(name);
            }
        }
        closedir(d);
        return files;
    }

    std::vector<unsigned int> getGridSize() {
        Operator* op = getOperator();
        if (!op) return {};
        return {
            op->GetNumberOfLines(0),
            op->GetNumberOfLines(1),
            op->GetNumberOfLines(2)
        };
    }

    std::vector<float> getVV() {
        return extractCoeffArray(0);
    }

    std::vector<float> getVI() {
        return extractCoeffArray(1);
    }

    std::vector<float> getII() {
        return extractCoeffArray(2);
    }

    std::vector<float> getIV() {
        return extractCoeffArray(3);
    }

private:
    openEMS* ems_;

    Operator* getOperator() {
        // Use the accessor to reach the protected FDTD_Op member
        return reinterpret_cast<openEMS_Accessor*>(ems_)->getFDTD_Op();
    }

    // Extract a full coefficient array (all 3 components, NIJK layout) as a flat vector.
    // arrayId: 0=vv, 1=vi, 2=ii, 3=iv
    std::vector<float> extractCoeffArray(int arrayId) {
        Operator* op = getOperator();
        if (!op) return {};

        unsigned int Nx = op->GetNumberOfLines(0);
        unsigned int Ny = op->GetNumberOfLines(1);
        unsigned int Nz = op->GetNumberOfLines(2);
        unsigned int total = 3 * Nx * Ny * Nz;

        std::vector<float> result(total);
        for (unsigned int n = 0; n < 3; n++) {
            for (unsigned int x = 0; x < Nx; x++) {
                for (unsigned int y = 0; y < Ny; y++) {
                    for (unsigned int z = 0; z < Nz; z++) {
                        unsigned int idx = n * Nx * Ny * Nz + x * Ny * Nz + y * Nz + z;
                        switch (arrayId) {
                            case 0: result[idx] = op->GetVV(n, x, y, z); break;
                            case 1: result[idx] = op->GetVI(n, x, y, z); break;
                            case 2: result[idx] = op->GetII(n, x, y, z); break;
                            case 3: result[idx] = op->GetIV(n, x, y, z); break;
                        }
                    }
                }
            }
        }
        return result;
    }
};

EMSCRIPTEN_BINDINGS(openems) {
    register_vector<std::string>("VectorString");
    register_vector<float>("VectorFloat");
    register_vector<unsigned int>("VectorUInt");

    class_<OpenEMSWrapper>("OpenEMS")
        .constructor<>()
        .function("configure", &OpenEMSWrapper::configure)
        .function("loadXML", &OpenEMSWrapper::loadXML)
        .function("setup", &OpenEMSWrapper::setup)
        .function("run", &OpenEMSWrapper::run)
        .function("readFile", &OpenEMSWrapper::readFile)
        .function("listFiles", &OpenEMSWrapper::listFiles)
        .function("getGridSize", &OpenEMSWrapper::getGridSize)
        .function("getVV", &OpenEMSWrapper::getVV)
        .function("getVI", &OpenEMSWrapper::getVI)
        .function("getII", &OpenEMSWrapper::getII)
        .function("getIV", &OpenEMSWrapper::getIV);
}
