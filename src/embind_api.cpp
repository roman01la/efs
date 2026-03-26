#include <emscripten/bind.h>
#include <fstream>
#include <sstream>
#include <dirent.h>
#include <string>
#include <vector>
#include "openems.h"

using namespace emscripten;

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

private:
    openEMS* ems_;
};

EMSCRIPTEN_BINDINGS(openems) {
    register_vector<std::string>("VectorString");

    class_<OpenEMSWrapper>("OpenEMS")
        .constructor<>()
        .function("configure", &OpenEMSWrapper::configure)
        .function("loadXML", &OpenEMSWrapper::loadXML)
        .function("setup", &OpenEMSWrapper::setup)
        .function("run", &OpenEMSWrapper::run)
        .function("readFile", &OpenEMSWrapper::readFile)
        .function("listFiles", &OpenEMSWrapper::listFiles);
}
