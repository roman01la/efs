#include <emscripten/bind.h>
#include <fstream>
#include <sstream>
#include <cstdio>
#include <stdexcept>
#include <atomic>
#include <dirent.h>
#include <string>
#include <vector>
#include "tinyxml.h"
#include "openems.h"
#include "FDTD/operator.h"
#include "ContinuousStructure.h"
#include "tools/hdf5_file_reader.h"

using namespace emscripten;

// Helper to access the protected FDTD_Op member of openEMS.
// We cannot modify vendor code, so we use a derived accessor class.
class openEMS_Accessor : public openEMS {
public:
    Operator* getFDTD_Op() const { return FDTD_Op; }
};

static std::atomic<int> g_xmlPathCounter{0};

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
        std::string path = "/tmp/sim_" + std::to_string(g_xmlPathCounter++) + ".xml";
        std::ofstream out(path);
        if (!out.is_open()) return false;
        out << xmlString;
        out.close();
        bool ok = ems_->ParseFDTDSetup(path);
        std::remove(path.c_str());
        return ok;
    }

    /**
     * Set a ContinuousStructure directly (skip XML round-trip).
     * The FDTD settings (excitation, BCs) must still come from loadXML or
     * be set via configure(). Call loadFDTDSettings() for the FDTD portion.
     */
    void setCSX(ContinuousStructure* csx) {
        ems_->SetCSX(csx);
    }

    /**
     * Parse only the <FDTD> settings from an XML string (excitation, BCs).
     * Does NOT overwrite the ContinuousStructure — use with setCSX().
     */
    bool loadFDTDSettings(const std::string& xmlString) {
        TiXmlDocument doc;
        doc.Parse(xmlString.c_str());
        if (doc.Error()) return false;
        TiXmlElement* root = doc.FirstChildElement("openEMS");
        if (!root) root = doc.RootElement();
        if (!root) return false;
        TiXmlElement* fdtd = root->FirstChildElement("FDTD");
        if (!fdtd) return false;
        return ems_->Parse_XML_FDTDSetup(fdtd);
    }

    int setup() {
        try {
            return ems_->SetupFDTD();
        } catch (int exitCode) {
            return exitCode != 0 ? exitCode : -1;
        } catch (...) {
            return -1;
        }
    }

    void run() {
        try {
            ems_->RunFDTD();
        } catch (int exitCode) {
            // Vendor exit() converted to throw — propagate as JS exception
            throw std::runtime_error("openEMS exited with code " + std::to_string(exitCode));
        }
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

    // -----------------------------------------------------------------------
    // HDF5 field data reading for NF2FF
    // -----------------------------------------------------------------------

    /**
     * Read mesh lines for a single axis from an HDF5 dump file.
     * @param filename Path to HDF5 file in MEMFS
     * @param axis 0=x/rho, 1=y/alpha, 2=z
     * @return Float vector of mesh line positions
     */
    std::vector<float> readHDF5Mesh(const std::string& filename, int axis) {
        HDF5_File_Reader reader(filename);
        float* lines[3] = {nullptr, nullptr, nullptr};
        unsigned int numLines[3] = {0, 0, 0};
        int meshType = 0;

        if (!reader.ReadMesh(lines, numLines, meshType)) {
            for (int i = 0; i < 3; i++) delete[] lines[i];
            return {};
        }

        if (axis < 0 || axis > 2) {
            for (int i = 0; i < 3; i++) delete[] lines[i];
            return {};
        }

        std::vector<float> result(lines[axis], lines[axis] + numLines[axis]);
        for (int i = 0; i < 3; i++) delete[] lines[i];
        return result;
    }

    /**
     * Get the mesh type from an HDF5 dump file.
     * @return 0 = Cartesian (x,y,z), 1 = cylindrical (rho,alpha,z)
     */
    int getHDF5MeshType(const std::string& filename) {
        HDF5_File_Reader reader(filename);
        float* lines[3] = {nullptr, nullptr, nullptr};
        unsigned int numLines[3] = {0, 0, 0};
        int meshType = 0;

        if (!reader.ReadMesh(lines, numLines, meshType)) {
            for (int i = 0; i < 3; i++) delete[] lines[i];
            return -1;
        }

        for (int i = 0; i < 3; i++) delete[] lines[i];
        return meshType;
    }

    /**
     * Read time-domain field data from an HDF5 dump file.
     * Returns a flat float array: [Nx*Ny*Nz*3] for one timestep.
     * Data is ordered as [component][x][y][z] matching openEMS convention.
     *
     * @param filename Path to HDF5 file
     * @param timestepIdx Index of timestep to read
     * @return Flat float array, empty if error
     */
    std::vector<float> readHDF5TDField(const std::string& filename, unsigned int timestepIdx) {
        HDF5_File_Reader reader(filename);
        float time;
        unsigned int data_size[4];
        float**** field = reader.GetTDVectorData(timestepIdx, time, data_size);
        if (!field) return {};

        // data_size: [Nx, Ny, Nz, 3]
        // Flatten: [d][i][j][k] with d=0..2, i=0..Nx-1, j=0..Ny-1, k=0..Nz-1
        unsigned int Nx = data_size[0], Ny = data_size[1], Nz = data_size[2];
        std::vector<float> result(3 * Nx * Ny * Nz);
        size_t pos = 0;
        for (unsigned int d = 0; d < 3; d++)
            for (unsigned int i = 0; i < Nx; i++)
                for (unsigned int j = 0; j < Ny; j++)
                    for (unsigned int k = 0; k < Nz; k++)
                        result[pos++] = field[d][i][j][k];

        // Free the 4D array
        for (unsigned int d = 0; d < 3; d++) {
            for (unsigned int i = 0; i < Nx; i++) {
                for (unsigned int j = 0; j < Ny; j++)
                    delete[] field[d][i][j];
                delete[] field[d][i];
            }
            delete[] field[d];
        }
        delete[] field;

        return result;
    }

    /**
     * Get the time attribute for a given timestep index.
     */
    float readHDF5TDTime(const std::string& filename, unsigned int timestepIdx) {
        HDF5_File_Reader reader(filename);
        float time = 0;
        unsigned int data_size[4];
        float**** field = reader.GetTDVectorData(timestepIdx, time, data_size);
        if (field) {
            unsigned int Nx = data_size[0], Ny = data_size[1], Nz = data_size[2];
            for (unsigned int d = 0; d < 3; d++) {
                for (unsigned int i = 0; i < Nx; i++) {
                    for (unsigned int j = 0; j < Ny; j++)
                        delete[] field[d][i][j];
                    delete[] field[d][i];
                }
                delete[] field[d];
            }
            delete[] field;
        }
        return time;
    }

    /**
     * Get the number of timesteps stored in a TD HDF5 dump file.
     */
    unsigned int getHDF5NumTimeSteps(const std::string& filename) {
        HDF5_File_Reader reader(filename);
        return reader.GetNumTimeSteps();
    }

    /**
     * Get the data dimensions [Nx, Ny, Nz] from the first timestep.
     */
    std::vector<unsigned int> getHDF5TDDataSize(const std::string& filename) {
        HDF5_File_Reader reader(filename);
        float time;
        unsigned int data_size[4];
        float**** field = reader.GetTDVectorData(0, time, data_size);
        if (!field) return {};

        unsigned int Nx = data_size[0], Ny = data_size[1], Nz = data_size[2];
        for (unsigned int d = 0; d < 3; d++) {
            for (unsigned int i = 0; i < Nx; i++) {
                for (unsigned int j = 0; j < Ny; j++)
                    delete[] field[d][i][j];
                delete[] field[d][i];
            }
            delete[] field[d];
        }
        delete[] field;

        return {Nx, Ny, Nz};
    }

    /**
     * Read frequency-domain field data from an HDF5 dump file.
     * Returns interleaved real/imaginary float array: [2*3*Nx*Ny*Nz]
     * ordered as [d][i][j][k] with real then imag for each element.
     *
     * @param filename Path to HDF5 file
     * @param freqIdx Frequency index to read
     * @return Flat float array with re/im interleaved, empty if error
     */
    std::vector<float> readHDF5FDField(const std::string& filename, unsigned int freqIdx) {
        HDF5_File_Reader reader(filename);
        unsigned int data_size[4];
        std::complex<float>**** field = reader.GetFDVectorData(freqIdx, data_size);
        if (!field) return {};

        unsigned int Nx = data_size[0], Ny = data_size[1], Nz = data_size[2];
        std::vector<float> result(2 * 3 * Nx * Ny * Nz);
        size_t pos = 0;
        for (unsigned int d = 0; d < 3; d++)
            for (unsigned int i = 0; i < Nx; i++)
                for (unsigned int j = 0; j < Ny; j++)
                    for (unsigned int k = 0; k < Nz; k++) {
                        result[pos++] = field[d][i][j][k].real();
                        result[pos++] = field[d][i][j][k].imag();
                    }

        // Free
        for (unsigned int d = 0; d < 3; d++) {
            for (unsigned int i = 0; i < Nx; i++) {
                for (unsigned int j = 0; j < Ny; j++)
                    delete[] field[d][i][j];
                delete[] field[d][i];
            }
            delete[] field[d];
        }
        delete[] field;

        return result;
    }

    /**
     * Read frequencies from an FD HDF5 dump file.
     */
    std::vector<float> readHDF5Frequencies(const std::string& filename) {
        HDF5_File_Reader reader(filename);
        std::vector<float> freqs;
        reader.ReadFrequencies(freqs);
        return freqs;
    }

    /**
     * Get the FD data dimensions [Nx, Ny, Nz] from frequency index 0.
     */
    std::vector<unsigned int> getHDF5FDDataSize(const std::string& filename) {
        HDF5_File_Reader reader(filename);
        unsigned int data_size[4];
        std::complex<float>**** field = reader.GetFDVectorData(0, data_size);
        if (!field) return {};

        unsigned int Nx = data_size[0], Ny = data_size[1], Nz = data_size[2];
        for (unsigned int d = 0; d < 3; d++) {
            for (unsigned int i = 0; i < Nx; i++) {
                for (unsigned int j = 0; j < Ny; j++)
                    delete[] field[d][i][j];
                delete[] field[d][i];
            }
            delete[] field[d];
        }
        delete[] field;

        return {Nx, Ny, Nz};
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
        .function("setCSX", &OpenEMSWrapper::setCSX, allow_raw_pointers())
        .function("loadFDTDSettings", &OpenEMSWrapper::loadFDTDSettings)
        .function("setup", &OpenEMSWrapper::setup)
        .function("run", &OpenEMSWrapper::run)
        .function("readFile", &OpenEMSWrapper::readFile)
        .function("listFiles", &OpenEMSWrapper::listFiles)
        .function("getGridSize", &OpenEMSWrapper::getGridSize)
        .function("getVV", &OpenEMSWrapper::getVV)
        .function("getVI", &OpenEMSWrapper::getVI)
        .function("getII", &OpenEMSWrapper::getII)
        .function("getIV", &OpenEMSWrapper::getIV)
        // HDF5 field data reading for NF2FF
        .function("readHDF5Mesh", &OpenEMSWrapper::readHDF5Mesh)
        .function("getHDF5MeshType", &OpenEMSWrapper::getHDF5MeshType)
        .function("readHDF5TDField", &OpenEMSWrapper::readHDF5TDField)
        .function("readHDF5TDTime", &OpenEMSWrapper::readHDF5TDTime)
        .function("getHDF5NumTimeSteps", &OpenEMSWrapper::getHDF5NumTimeSteps)
        .function("getHDF5TDDataSize", &OpenEMSWrapper::getHDF5TDDataSize)
        .function("readHDF5FDField", &OpenEMSWrapper::readHDF5FDField)
        .function("readHDF5Frequencies", &OpenEMSWrapper::readHDF5Frequencies)
        .function("getHDF5FDDataSize", &OpenEMSWrapper::getHDF5FDDataSize);
}
