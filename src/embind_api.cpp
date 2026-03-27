#include <emscripten/bind.h>
#include <fstream>
#include <sstream>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <atomic>
#include <dirent.h>
#include <string>
#include <vector>
#include "tinyxml.h"
#include "Common/processing.h"
#include "Common/processintegral.h"
#include "Common/processvoltage.h"
#include "Common/processcurrent.h"
#include "openems.h"
#include "FDTD/operator.h"
#include "FDTD/engine.h"
#include "FDTD/excitation.h"
#include "FDTD/extensions/operator_ext_excitation.h"
#include "FDTD/extensions/operator_ext_upml.h"
#include "FDTD/extensions/engine_ext_upml.h"
#include "FDTD/extensions/operator_ext_mur_abc.h"
#include "FDTD/engine_interface_fdtd.h"
#include "Common/processfields.h"
#include "Common/processing.h"
#include "ContinuousStructure.h"
#include "tools/hdf5_file_reader.h"

using namespace emscripten;

// Helper to access the protected FDTD_Op member of openEMS.
// We cannot modify vendor code, so we use a derived accessor class.
class openEMS_Accessor : public openEMS {
public:
    Operator* getFDTD_Op() const { return FDTD_Op; }
    Engine* getFDTD_Eng() const { return FDTD_Eng; }
    ProcessingArray* getPA() const { return PA; }
    unsigned int getNrTS() const { return NrTS; }
    double getEndCrit() const { return endCrit; }
    Excitation* getExc() const { return m_Exc; }
    Engine_Ext_SteadyState* getEngExtSSD() const { return Eng_Ext_SSD; }
};

// Helper to access protected engine fields (volt_ptr, curr_ptr, numTS).
class Engine_Accessor : public Engine {
public:
    ArrayLib::ArrayNIJK<FDTD_FLOAT>* getVoltPtr() const { return volt_ptr; }
    ArrayLib::ArrayNIJK<FDTD_FLOAT>* getCurrPtr() const { return curr_ptr; }
    void setNumTS(unsigned int ts) { numTS = ts; }
};

// Accessors for protected extension fields.
class UPML_Accessor : public Operator_Ext_UPML {
public:
    unsigned int* startPos() { return m_StartPos; }
    unsigned int* numLines() { return m_numLines; }
    ArrayLib::ArrayNIJK<FDTD_FLOAT>& getVV()   { return vv; }
    ArrayLib::ArrayNIJK<FDTD_FLOAT>& getVVFO() { return vvfo; }
    ArrayLib::ArrayNIJK<FDTD_FLOAT>& getVVFN() { return vvfn; }
    ArrayLib::ArrayNIJK<FDTD_FLOAT>& getII()   { return ii; }
    ArrayLib::ArrayNIJK<FDTD_FLOAT>& getIIFO() { return iifo; }
    ArrayLib::ArrayNIJK<FDTD_FLOAT>& getIIFN() { return iifn; }
};

class Excitation_Accessor : public Operator_Ext_Excitation {
public:
    FDTD_FLOAT* getVoltAmp() const { return Volt_amp; }
    unsigned int* getVoltDelay() const { return Volt_delay; }
    unsigned short* getVoltDir() const { return Volt_dir; }
    unsigned int* getVoltIndex(int dim) const { return Volt_index[dim]; }
};

class Mur_Accessor : public Operator_Ext_Mur_ABC {
public:
    int getNY() const { return m_ny; }
    bool getTop() const { return m_top; }
    unsigned int getLineNr() const { return m_LineNr; }
    int getLineNrShift() const { return m_LineNr_Shift; }
    unsigned int* getNumLines() { return m_numLines; }
    ArrayLib::ArrayIJ<FDTD_FLOAT>& getCoeffNyP()  { return m_Mur_Coeff_nyP; }
    ArrayLib::ArrayIJ<FDTD_FLOAT>& getCoeffNyPP() { return m_Mur_Coeff_nyPP; }
};

// Accessor for Processing protected members (start/stop grid coords)
class Processing_Accessor : public Processing {
public:
    const unsigned int* getStart() const { return start; }
    const unsigned int* getStop() const { return stop; }
};

// Accessor for ProcessIntegral protected members (m_Results)
class ProcessIntegral_Accessor : public ProcessIntegral {
public:
    double* getResults() { return m_Results; }
    void setResult(int idx, double val) { if (m_Results) m_Results[idx] = val; }
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
    // Hybrid GPU/WASM stepping API
    // -----------------------------------------------------------------------

    /**
     * Initialize the FDTD run loop (mirrors the setup part of RunFDTD).
     * Returns the first processing step interval.
     * After this, caller runs GPU iterations, then calls doProcess() in a loop.
     */
    int initRun() {
        auto* acc = reinterpret_cast<openEMS_Accessor*>(ems_);
        Engine* eng = acc->getFDTD_Eng();
        ProcessingArray* pa = acc->getPA();
        Operator* op = acc->getFDTD_Op();

        if (!eng || !pa || !op) return -1;

        // Mirror RunFDTD setup: add end-criteria field processing
        procField_ = new ProcessFields(acc->NewEngineInterface());
        pa->AddProcessing(procField_);
        maxEnergy_ = 0;
        energyChange_ = 1;

        pa->InitAll();

        unsigned int maxExcite = op->GetExcitationSignal()->GetMaxExcitationTimestep();
        procField_->AddStep(maxExcite);

        pa->PreProcess();
        int step = pa->Process();
        unsigned int NrTS = acc->getNrTS();
        if ((step < 0) || (step > (int)NrTS)) step = NrTS;

        return step;
    }

    /**
     * Run one processing cycle after GPU has advanced the fields.
     * Returns the next step interval, or 0 if simulation should end.
     */
    int doProcess() {
        auto* acc = reinterpret_cast<openEMS_Accessor*>(ems_);
        Engine* eng = acc->getFDTD_Eng();
        ProcessingArray* pa = acc->getPA();
        unsigned int NrTS = acc->getNrTS();
        double endCrit = acc->getEndCrit();

        int step = pa->Process();

        // Check end criteria via energy estimate
        if (procField_ && procField_->CheckTimestep()) {
            double currE = procField_->CalcTotalEnergyEstimate();
            if (currE > maxEnergy_) maxEnergy_ = currE;
            if (maxEnergy_ > 0) energyChange_ = currE / maxEnergy_;
        }

        unsigned int currTS = eng->GetNumberOfTimesteps();
        if ((step < 0) || (step > (int)(NrTS - currTS))) step = NrTS - currTS;

        // Check if done
        if (currTS >= NrTS || energyChange_ <= endCrit) return 0;

        return step;
    }

    unsigned int getTimestepCount() {
        auto* eng = getEngine();
        return eng ? eng->GetNumberOfTimesteps() : 0;
    }

    unsigned int getMaxTimesteps() {
        auto* acc = reinterpret_cast<openEMS_Accessor*>(ems_);
        return acc->getNrTS();
    }

    /**
     * Get the WASM heap pointer and size of the voltage field array.
     * JS can write directly to HEAPF32 at this offset for zero-copy transfer.
     * Returns [pointer, count] where pointer is byte offset into WASM memory.
     */
    std::vector<unsigned int> getVoltagePtr() {
        auto* eng = getEngine();
        if (!eng) return {};
        auto* engAcc = reinterpret_cast<Engine_Accessor*>(eng);
        auto* voltArr = engAcc->getVoltPtr();
        if (!voltArr || !voltArr->valid()) return {};
        return { (unsigned int)(uintptr_t)voltArr->data(), (unsigned int)voltArr->size() };
    }

    /**
     * Get the WASM heap pointer and size of the current field array.
     */
    std::vector<unsigned int> getCurrentPtr() {
        auto* eng = getEngine();
        if (!eng) return {};
        auto* engAcc = reinterpret_cast<Engine_Accessor*>(eng);
        auto* currArr = engAcc->getCurrPtr();
        if (!currArr || !currArr->valid()) return {};
        return { (unsigned int)(uintptr_t)currArr->data(), (unsigned int)currArr->size() };
    }

    /**
     * Write voltage field data from GPU back into the C++ engine.
     * Input: flat float array in NIJK layout (3 * Nx * Ny * Nz).
     */
    void setVoltages(const std::vector<float>& data) {
        auto* eng = getEngine();
        if (!eng) return;
        auto* engAcc = reinterpret_cast<Engine_Accessor*>(eng);
        auto* voltArr = engAcc->getVoltPtr();
        if (!voltArr || !voltArr->valid()) return;
        FDTD_FLOAT* dst = voltArr->data();
        size_t count = std::min(data.size(), (size_t)voltArr->size());
        for (size_t i = 0; i < count; i++) dst[i] = data[i];
    }

    /**
     * Write current field data from GPU back into the C++ engine.
     * Input: flat float array in NIJK layout (3 * Nx * Ny * Nz).
     */
    void setCurrents(const std::vector<float>& data) {
        auto* eng = getEngine();
        if (!eng) return;
        auto* engAcc = reinterpret_cast<Engine_Accessor*>(eng);
        auto* currArr = engAcc->getCurrPtr();
        if (!currArr || !currArr->valid()) return;
        FDTD_FLOAT* dst = currArr->data();
        size_t count = std::min(data.size(), (size_t)currArr->size());
        for (size_t i = 0; i < count; i++) dst[i] = data[i];
    }

    /**
     * Set the engine's internal timestep counter (so processing knows the time).
     */
    void setTimestepCount(unsigned int ts) {
        auto* eng = getEngine();
        if (!eng) return;
        reinterpret_cast<Engine_Accessor*>(eng)->setNumTS(ts);
    }

    /**
     * Copy field data from a staging buffer (allocated via _malloc) into the
     * engine's voltage and current arrays.  This avoids SharedArrayBuffer
     * visibility issues by doing the copy entirely in C++.
     */
    /**
     * Copy field data from a staging buffer into the engine using virtual
     * SetVolt/SetCurr (works with basic, SSE, and SSE-compressed engines).
     * Layout: flat NIJK order — [n][x][y][z] for n=0..2, matching GPU output.
     */
    void copyFieldsFromStaging(uintptr_t voltSrc, uintptr_t currSrc, unsigned int count) {
        auto* eng = getEngine();
        if (!eng) return;
        Operator* op = getOperator();
        if (!op) return;
        unsigned int Nx = op->GetNumberOfLines(0);
        unsigned int Ny = op->GetNumberOfLines(1);
        unsigned int Nz = op->GetNumberOfLines(2);
        const float* vSrc = reinterpret_cast<const float*>(voltSrc);
        const float* cSrc = reinterpret_cast<const float*>(currSrc);
        unsigned int idx = 0;
        for (unsigned int n = 0; n < 3; n++)
            for (unsigned int x = 0; x < Nx; x++)
                for (unsigned int y = 0; y < Ny; y++)
                    for (unsigned int z = 0; z < Nz; z++, idx++) {
                        eng->SetVolt(n, x, y, z, vSrc[idx]);
                        eng->SetCurr(n, x, y, z, cSrc[idx]);
                    }
    }

    /**
     * Extract probe definitions for GPU-side evaluation.
     * Returns flat array: [numProbes, then for each probe 10 floats:
     *   startX, startY, startZ, stopX, stopY, stopZ, component, sign, weight, type]
     * type: 0=voltage, 1=current
     */
    std::vector<float> getProbeDefinitions() {
        auto* omsAcc = reinterpret_cast<openEMS_Accessor*>(ems_);
        ProcessingArray* pa = omsAcc->getPA();
        if (!pa) return {};

        std::vector<float> result;
        unsigned int count = 0;
        result.push_back(0); // placeholder for count

        for (size_t i = 0; i < pa->GetNumberOfProcessings(); i++) {
            Processing* proc = pa->GetProcessing(i);
            if (!proc) continue;

            // Only handle voltage and current probes
            ProcessVoltage* pv = dynamic_cast<ProcessVoltage*>(proc);
            ProcessCurrent* pc = dynamic_cast<ProcessCurrent*>(proc);
            if (!pv && !pc) continue;

            auto* procAcc = reinterpret_cast<Processing_Accessor*>(proc);
            const unsigned int* start = procAcc->getStart();
            const unsigned int* stop = procAcc->getStop();

            // Determine integration direction and sign
            int component = -1;
            float sign = 1.0f;
            for (int d = 0; d < 3; d++) {
                if (start[d] != stop[d]) {
                    component = d;
                    if (start[d] > stop[d]) sign = -1.0f;
                    break;
                }
            }
            if (component < 0) continue;

            float weight = proc->GetWeight();
            float type = pv ? 0.0f : 1.0f;

            result.push_back((float)start[0]);
            result.push_back((float)start[1]);
            result.push_back((float)start[2]);
            result.push_back((float)stop[0]);
            result.push_back((float)stop[1]);
            result.push_back((float)stop[2]);
            result.push_back((float)component);
            result.push_back(sign);
            result.push_back(weight);
            result.push_back(type);
            count++;
        }
        result[0] = (float)count;
        return result;
    }

    /**
     * Inject GPU-computed probe results into the processing pipeline and
     * advance file writing / FD accumulation / end-criteria checking.
     *
     * valuesPtr: pointer to float array of probe integral results (from GPU)
     *            in the same order as getProbeDefinitions().
     * Returns: next processing interval, or <=0 if simulation should stop.
     */
    int processProbeResults(uintptr_t valuesPtr, unsigned int numProbes, unsigned int timestep) {
        auto* omsAcc = reinterpret_cast<openEMS_Accessor*>(ems_);
        auto* eng = getEngine();
        ProcessingArray* pa = omsAcc->getPA();
        if (!eng || !pa) return -1;

        const float* values = reinterpret_cast<const float*>(valuesPtr);
        reinterpret_cast<Engine_Accessor*>(eng)->setNumTS(timestep);

        // Inject results into each matching ProcessIntegral
        unsigned int probeIdx = 0;
        for (size_t i = 0; i < pa->GetNumberOfProcessings(); i++) {
            Processing* proc = pa->GetProcessing(i);
            ProcessVoltage* pv = dynamic_cast<ProcessVoltage*>(proc);
            ProcessCurrent* pc = dynamic_cast<ProcessCurrent*>(proc);
            if (!pv && !pc) continue;

            auto* procAcc = reinterpret_cast<Processing_Accessor*>(proc);
            const unsigned int* start = procAcc->getStart();
            const unsigned int* stop = procAcc->getStop();
            bool hasDir = false;
            for (int d = 0; d < 3; d++)
                if (start[d] != stop[d]) hasDir = true;
            if (!hasDir) continue;

            if (probeIdx < numProbes) {
                auto* piAcc = reinterpret_cast<ProcessIntegral_Accessor*>(proc);
                piAcc->setResult(0, (double)values[probeIdx]);
                probeIdx++;
            }
        }

        return pa->Process();
    }

    /**
     * Debug: return peak absolute value in the engine's voltage array.
     * Used to verify JS→WASM memory writes are visible to C++.
     */
    float debugVoltPeak() {
        auto* eng = getEngine();
        if (!eng) return -1;
        Operator* op = getOperator();
        if (!op) return -2;
        unsigned int Nx = op->GetNumberOfLines(0);
        unsigned int Ny = op->GetNumberOfLines(1);
        unsigned int Nz = op->GetNumberOfLines(2);
        float peak = 0;
        for (unsigned int n = 0; n < 3; n++)
            for (unsigned int x = 0; x < Nx; x++)
                for (unsigned int y = 0; y < Ny; y++)
                    for (unsigned int z = 0; z < Nz; z++) {
                        float v = eng->GetVolt(n, x, y, z);
                        if (v < 0) v = -v;
                        if (v > peak) peak = v;
                    }
        return peak;
    }

    /**
     * Finalize the run (post-processing flush).
     */
    void finalizeRun() {
        auto* acc = reinterpret_cast<openEMS_Accessor*>(ems_);
        ProcessingArray* pa = acc->getPA();
        if (pa) {
            pa->FlushNext();
            pa->Process();
        }
    }

    // -----------------------------------------------------------------------
    // Extension data extraction for GPU engine configuration
    // -----------------------------------------------------------------------

    /**
     * Extract excitation signal (time-domain waveform).
     * Returns [length, signal[0], signal[1], ...].
     */
    std::vector<float> getExcitationSignal() {
        Operator* op = getOperator();
        if (!op) return {};
        Excitation* exc = op->GetExcitationSignal();
        if (!exc) return {};
        unsigned int len = exc->GetLength();
        FDTD_FLOAT* sig = exc->GetVoltageSignal();
        if (!sig || len == 0) return {};
        std::vector<float> result(sig, sig + len);
        return result;
    }

    /**
     * Get excitation signal period (0 if not periodic).
     */
    float getExcitationPeriod() {
        Operator* op = getOperator();
        if (!op) return 0;
        Excitation* exc = op->GetExcitationSignal();
        return exc ? (float)exc->GetSignalPeriod() : 0;
    }

    /**
     * Extract voltage excitation point data from the operator extension.
     * Returns flat arrays: [count, amp0, amp1, ..., delay0, delay1, ...,
     *                       dir0, dir1, ..., posX0, posX1, ..., posY0, ..., posZ0, ...]
     * JS side unpacks these into separate typed arrays.
     */
    std::vector<float> getExcitationVoltages() {
        Operator* op = getOperator();
        if (!op) return {};

        // Find the excitation extension
        Operator_Ext_Excitation* excExt = nullptr;
        for (size_t i = 0; i < op->GetNumberOfExtentions(); i++) {
            excExt = dynamic_cast<Operator_Ext_Excitation*>(op->GetExtension(i));
            if (excExt) break;
        }
        if (!excExt) return {};

        auto* acc = reinterpret_cast<Excitation_Accessor*>(excExt);
        unsigned int count = excExt->GetVoltCount();
        if (count == 0) return {};

        // Pack: [count, amp[count], delay[count], dir[count], pos[count]]
        std::vector<float> result;
        result.reserve(1 + 4 * count);
        result.push_back((float)count);

        // Amplitudes
        FDTD_FLOAT* amp = acc->getVoltAmp();
        for (unsigned int i = 0; i < count; i++)
            result.push_back(amp[i]);
        // Delays
        unsigned int* delay = acc->getVoltDelay();
        for (unsigned int i = 0; i < count; i++)
            result.push_back((float)delay[i]);
        // Directions
        unsigned short* dir = acc->getVoltDir();
        for (unsigned int i = 0; i < count; i++)
            result.push_back((float)dir[i]);
        // Linear positions in NIJK layout
        unsigned int Nx = op->GetNumberOfLines(0);
        unsigned int Ny = op->GetNumberOfLines(1);
        unsigned int Nz = op->GetNumberOfLines(2);
        for (unsigned int i = 0; i < count; i++) {
            unsigned int d = dir[i];
            unsigned int x = acc->getVoltIndex(0)[i];
            unsigned int y = acc->getVoltIndex(1)[i];
            unsigned int z = acc->getVoltIndex(2)[i];
            // Position WITHOUT direction — shader adds dir*Nx*Ny*Nz separately
            float pos = (float)(x * Ny * Nz + y * Nz + z);
            result.push_back(pos);
        }

        return result;
    }

    /**
     * Get number of PML regions (UPML extensions).
     */
    unsigned int getPMLCount() {
        Operator* op = getOperator();
        if (!op) return 0;
        unsigned int count = 0;
        for (size_t i = 0; i < op->GetNumberOfExtentions(); i++) {
            if (dynamic_cast<Operator_Ext_UPML*>(op->GetExtension(i)))
                count++;
        }
        return count;
    }

    /**
     * Extract PML region data for a specific PML index.
     * Returns flat array: [startX, startY, startZ, numX, numY, numZ,
     *                       vv[3*nx*ny*nz], vvfo[...], vvfn[...], ii[...], iifo[...], iifn[...]]
     */
    std::vector<float> getPMLRegion(unsigned int pmlIdx) {
        Operator* op = getOperator();
        if (!op) return {};

        unsigned int idx = 0;
        Operator_Ext_UPML* pml = nullptr;
        for (size_t i = 0; i < op->GetNumberOfExtentions(); i++) {
            pml = dynamic_cast<Operator_Ext_UPML*>(op->GetExtension(i));
            if (pml) {
                if (idx == pmlIdx) break;
                idx++;
                pml = nullptr;
            }
        }
        if (!pml) return {};

        auto* acc = reinterpret_cast<UPML_Accessor*>(pml);
        std::vector<float> result;
        // Header: startPos[3], numLines[3]
        result.push_back((float)acc->startPos()[0]);
        result.push_back((float)acc->startPos()[1]);
        result.push_back((float)acc->startPos()[2]);
        result.push_back((float)acc->numLines()[0]);
        result.push_back((float)acc->numLines()[1]);
        result.push_back((float)acc->numLines()[2]);

        unsigned int total = 3 * acc->numLines()[0] * acc->numLines()[1] * acc->numLines()[2];

        // Extract NIJK arrays via data() pointer
        auto appendArray = [&](ArrayLib::ArrayNIJK<FDTD_FLOAT>& arr) {
            FDTD_FLOAT* ptr = arr.data();
            for (unsigned int i = 0; i < total; i++)
                result.push_back(ptr[i]);
        };

        appendArray(acc->getVV());
        appendArray(acc->getVVFO());
        appendArray(acc->getVVFN());
        appendArray(acc->getII());
        appendArray(acc->getIIFO());
        appendArray(acc->getIIFN());

        return result;
    }

    /**
     * Get number of Mur ABC regions.
     */
    unsigned int getMurCount() {
        Operator* op = getOperator();
        if (!op) return 0;
        unsigned int count = 0;
        for (size_t i = 0; i < op->GetNumberOfExtentions(); i++) {
            if (dynamic_cast<Operator_Ext_Mur_ABC*>(op->GetExtension(i)))
                count++;
        }
        return count;
    }

    /**
     * Extract Mur ABC data for a specific index.
     * Returns: [ny, top, lineNr, lineNr_shift, numLines0, numLines1,
     *           coeffNyP[n0*n1], coeffNyPP[n0*n1]]
     */
    std::vector<float> getMurRegion(unsigned int murIdx) {
        Operator* op = getOperator();
        if (!op) return {};

        unsigned int idx = 0;
        Operator_Ext_Mur_ABC* mur = nullptr;
        for (size_t i = 0; i < op->GetNumberOfExtentions(); i++) {
            mur = dynamic_cast<Operator_Ext_Mur_ABC*>(op->GetExtension(i));
            if (mur) {
                if (idx == murIdx) break;
                idx++;
                mur = nullptr;
            }
        }
        if (!mur) return {};

        auto* acc = reinterpret_cast<Mur_Accessor*>(mur);
        std::vector<float> result;
        result.push_back((float)acc->getNY());
        result.push_back(acc->getTop() ? 1.0f : 0.0f);
        result.push_back((float)acc->getLineNr());
        result.push_back((float)acc->getLineNrShift());
        result.push_back((float)acc->getNumLines()[0]);
        result.push_back((float)acc->getNumLines()[1]);

        unsigned int n0 = acc->getNumLines()[0];
        unsigned int n1 = acc->getNumLines()[1];

        // Coefficients stored in ArrayIJ
        FDTD_FLOAT* coeffP = acc->getCoeffNyP().data();
        FDTD_FLOAT* coeffPP = acc->getCoeffNyPP().data();
        for (unsigned int i = 0; i < n0 * n1; i++)
            result.push_back(coeffP[i]);
        for (unsigned int i = 0; i < n0 * n1; i++)
            result.push_back(coeffPP[i]);

        return result;
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
    ProcessFields* procField_ = nullptr;
    double maxEnergy_ = 0;
    double energyChange_ = 1;

    Operator* getOperator() {
        return reinterpret_cast<openEMS_Accessor*>(ems_)->getFDTD_Op();
    }

    Engine* getEngine() {
        return reinterpret_cast<openEMS_Accessor*>(ems_)->getFDTD_Eng();
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
        // Hybrid GPU/WASM stepping API
        .function("initRun", &OpenEMSWrapper::initRun)
        .function("doProcess", &OpenEMSWrapper::doProcess)
        .function("getTimestepCount", &OpenEMSWrapper::getTimestepCount)
        .function("getMaxTimesteps", &OpenEMSWrapper::getMaxTimesteps)
        .function("getVoltagePtr", &OpenEMSWrapper::getVoltagePtr)
        .function("getCurrentPtr", &OpenEMSWrapper::getCurrentPtr)
        .function("setVoltages", &OpenEMSWrapper::setVoltages)
        .function("setCurrents", &OpenEMSWrapper::setCurrents)
        .function("setTimestepCount", &OpenEMSWrapper::setTimestepCount)
        .function("copyFieldsFromStaging", &OpenEMSWrapper::copyFieldsFromStaging)
        .function("debugVoltPeak", &OpenEMSWrapper::debugVoltPeak)
        .function("getProbeDefinitions", &OpenEMSWrapper::getProbeDefinitions)
        .function("processProbeResults", &OpenEMSWrapper::processProbeResults)
        .function("finalizeRun", &OpenEMSWrapper::finalizeRun)
        // Extension data extraction for GPU
        .function("getExcitationSignal", &OpenEMSWrapper::getExcitationSignal)
        .function("getExcitationPeriod", &OpenEMSWrapper::getExcitationPeriod)
        .function("getExcitationVoltages", &OpenEMSWrapper::getExcitationVoltages)
        .function("getPMLCount", &OpenEMSWrapper::getPMLCount)
        .function("getPMLRegion", &OpenEMSWrapper::getPMLRegion)
        .function("getMurCount", &OpenEMSWrapper::getMurCount)
        .function("getMurRegion", &OpenEMSWrapper::getMurRegion)
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
