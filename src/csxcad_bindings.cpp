/**
 * Embind bindings for CSXCAD — exposes the native C++ geometry/property
 * model to JavaScript so simulations can be built without XML reimplementation.
 *
 * Usage from JS:
 *   const Module = await createOpenEMS();
 *   const csx = new Module.ContinuousStructure();
 *   const grid = csx.GetGrid();
 *   grid.SetDeltaUnit(1e-3);
 *   grid.AddDiscLine(0, 0.0);  // x-line
 *   ...
 *   const ps = csx.GetParameterSet();
 *   const metal = new Module.CSPropMetal(ps);
 *   metal.SetName("patch");
 *   csx.AddProperty(metal);
 *   const box = new Module.CSPrimBox(ps, metal);
 *   box.SetCoord(0, xmin); ... box.SetCoord(5, zmax);
 *   box.SetPriority(10);
 *   metal.AddPrimitive(box);
 *   const xml = Module.csxToXML(csx);
 */

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <string>
#include <vector>
#include "tinyxml.h"

#include "ContinuousStructure.h"
#include "CSRectGrid.h"
#include "CSBackgroundMaterial.h"
#include "ParameterObjects.h"

// Properties
#include "CSProperties.h"
#include "CSPropMetal.h"
#include "CSPropMaterial.h"
#include "CSPropExcitation.h"
#include "CSPropProbeBox.h"
#include "CSPropDumpBox.h"
#include "CSPropLumpedElement.h"
#include "CSPropConductingSheet.h"
#include "CSPropDispersiveMaterial.h"
#include "CSPropLorentzMaterial.h"
#include "CSPropDebyeMaterial.h"
#include "CSPropDiscMaterial.h"
#include "CSPropResBox.h"

// Primitives
#include "CSPrimitives.h"
#include "CSPrimBox.h"
#include "CSPrimCylinder.h"
#include "CSPrimCylindricalShell.h"
#include "CSPrimSphere.h"
#include "CSPrimSphericalShell.h"
#include "CSPrimPolygon.h"
#include "CSPrimLinPoly.h"
#include "CSPrimRotPoly.h"
#include "CSPrimCurve.h"
#include "CSPrimWire.h"
#include "CSPrimPoint.h"
#include "CSPrimMultiBox.h"

using namespace emscripten;

// ---------------------------------------------------------------------------
// Factory functions (Embind can't handle raw-pointer constructors directly)
// ---------------------------------------------------------------------------

static CSPropMetal* createCSPropMetal(ParameterSet* ps) { return new CSPropMetal(ps); }
static CSPropMaterial* createCSPropMaterial(ParameterSet* ps) { return new CSPropMaterial(ps); }
static CSPropExcitation* createCSPropExcitation(ParameterSet* ps, unsigned int n) { return new CSPropExcitation(ps, n); }
static CSPropProbeBox* createCSPropProbeBox(ParameterSet* ps) { return new CSPropProbeBox(ps); }
static CSPropDumpBox* createCSPropDumpBox(ParameterSet* ps) { return new CSPropDumpBox(ps); }
static CSPropLumpedElement* createCSPropLumpedElement(ParameterSet* ps) { return new CSPropLumpedElement(ps); }
static CSPropConductingSheet* createCSPropConductingSheet(ParameterSet* ps) { return new CSPropConductingSheet(ps); }
static CSPropLorentzMaterial* createCSPropLorentzMaterial(ParameterSet* ps) { return new CSPropLorentzMaterial(ps); }
static CSPropDebyeMaterial* createCSPropDebyeMaterial(ParameterSet* ps) { return new CSPropDebyeMaterial(ps); }
static CSPropDiscMaterial* createCSPropDiscMaterial(ParameterSet* ps) { return new CSPropDiscMaterial(ps); }
static CSPropResBox* createCSPropResBox(ParameterSet* ps) { return new CSPropResBox(ps); }

static CSPrimBox* createCSPrimBox(ParameterSet* ps, CSProperties* prop) { return new CSPrimBox(ps, prop); }
static CSPrimCylinder* createCSPrimCylinder(ParameterSet* ps, CSProperties* prop) { return new CSPrimCylinder(ps, prop); }
static CSPrimCylindricalShell* createCSPrimCylindricalShell(ParameterSet* ps, CSProperties* prop) { return new CSPrimCylindricalShell(ps, prop); }
static CSPrimSphere* createCSPrimSphere(ParameterSet* ps, CSProperties* prop) { return new CSPrimSphere(ps, prop); }
static CSPrimSphericalShell* createCSPrimSphericalShell(ParameterSet* ps, CSProperties* prop) { return new CSPrimSphericalShell(ps, prop); }
static CSPrimPolygon* createCSPrimPolygon(ParameterSet* ps, CSProperties* prop) { return new CSPrimPolygon(ps, prop); }
static CSPrimLinPoly* createCSPrimLinPoly(ParameterSet* ps, CSProperties* prop) { return new CSPrimLinPoly(ps, prop); }
static CSPrimRotPoly* createCSPrimRotPoly(ParameterSet* ps, CSProperties* prop) { return new CSPrimRotPoly(ps, prop); }
static CSPrimCurve* createCSPrimCurve(ParameterSet* ps, CSProperties* prop) { return new CSPrimCurve(ps, prop); }
static CSPrimWire* createCSPrimWire(ParameterSet* ps, CSProperties* prop) { return new CSPrimWire(ps, prop); }
static CSPrimPoint* createCSPrimPoint(ParameterSet* ps, CSProperties* prop) { return new CSPrimPoint(ps, prop); }
static CSPrimMultiBox* createCSPrimMultiBox(ParameterSet* ps, CSProperties* prop) { return new CSPrimMultiBox(ps, prop); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialize a ContinuousStructure to an XML string. */
static std::string csxToXML(ContinuousStructure& csx) {
    TiXmlDocument doc;
    csx.Write2XML(&doc, false);
    TiXmlPrinter printer;
    printer.SetIndent("  ");
    doc.Accept(&printer);
    return std::string(printer.CStr());
}

/** Parse a ContinuousStructure from an XML string.  Returns error message (empty=ok). */
static std::string csxFromXML(ContinuousStructure& csx, const std::string& xmlStr) {
    TiXmlDocument doc;
    doc.Parse(xmlStr.c_str());
    if (doc.Error()) return std::string("XML parse error: ") + doc.ErrorDesc();
    TiXmlElement* root = doc.FirstChildElement("ContinuousStructure");
    if (!root) root = doc.RootElement();
    if (!root) return "No root element";
    const char* err = csx.ReadFromXML(root);
    return err ? std::string(err) : std::string();
}

/** Helper: get grid lines as a flat vector (since GetLines returns raw ptr). */
static std::vector<double> gridGetLines(CSRectGrid& grid, int dir) {
    unsigned int qty = 0;
    double* lines = grid.GetLines(dir, nullptr, qty, true);
    if (!lines || qty == 0) return {};
    std::vector<double> result(lines, lines + qty);
    delete[] lines;
    return result;
}

/** Helper: add multiple grid lines at once from a JS array. */
static void gridSetLines(CSRectGrid& grid, int dir, const std::vector<double>& lines) {
    for (double v : lines) grid.AddDiscLine(dir, v);
    grid.Sort(dir);
}

/** Helper: set polygon coords from flat [x0,y0,x1,y1,...] array. */
static void polygonSetCoords(CSPrimPolygon& poly, const std::vector<double>& coords) {
    poly.ClearCoords();
    for (double v : coords) poly.AddCoord(v);
}

/** Helper: get polygon coords as flat vector. */
static std::vector<double> polygonGetCoords(CSPrimPolygon& poly) {
    std::vector<double> result;
    size_t n = poly.GetQtyCoords();
    for (size_t i = 0; i < n; i++) result.push_back(poly.GetCoord(i));
    return result;
}

/** Helper: add a 3D point to a curve. */
static void curveAddPoint3(CSPrimCurve& curve, double x, double y, double z) {
    double coords[3] = {x, y, z};
    curve.AddPoint(coords);
}

/** Helper: get curve point as vector. */
static std::vector<double> curveGetPoint(CSPrimCurve& curve, size_t idx) {
    double pt[3] = {0, 0, 0};
    curve.GetPoint(idx, pt);
    return {pt[0], pt[1], pt[2]};
}

/** Helper: set box start/stop from 6 values.
 *  CSXCAD indices are interleaved: [P1x, P2x, P1y, P2y, P1z, P2z]. */
static void boxSetStartStop(CSPrimBox& box,
    double x0, double y0, double z0,
    double x1, double y1, double z1)
{
    box.SetCoord(0, x0); box.SetCoord(1, x1);
    box.SetCoord(2, y0); box.SetCoord(3, y1);
    box.SetCoord(4, z0); box.SetCoord(5, z1);
}

/** Helper: set cylinder axis start/stop + radius.
 *  CSXCAD indices are interleaved: [P1x, P2x, P1y, P2y, P1z, P2z]. */
static void cylinderSetAxis(CSPrimCylinder& cyl,
    double x0, double y0, double z0,
    double x1, double y1, double z1,
    double radius)
{
    cyl.SetCoord(0, x0); cyl.SetCoord(1, x1);
    cyl.SetCoord(2, y0); cyl.SetCoord(3, y1);
    cyl.SetCoord(4, z0); cyl.SetCoord(5, z1);
    cyl.SetRadius(radius);
}

/** Helper: get count of properties matching a name. */
static size_t csGetPropertiesByNameCount(ContinuousStructure& csx, const std::string& name) {
    return csx.GetPropertiesByName(name).size();
}

/** Helper: get property by name at index. */
static CSProperties* csGetPropertiesByNameAt(ContinuousStructure& csx, const std::string& name, size_t idx) {
    std::vector<CSProperties*> props = csx.GetPropertiesByName(name);
    if (idx < props.size()) return props[idx];
    return nullptr;
}

/** Helper: get all primitives count. */
static size_t csGetAllPrimitivesCount(ContinuousStructure& csx, bool sorted) {
    return csx.GetAllPrimitives(sorted).size();
}

/** Helper: get primitive at index from all primitives. */
static CSPrimitives* csGetAllPrimitivesAt(ContinuousStructure& csx, bool sorted, size_t idx) {
    std::vector<CSPrimitives*> prims = csx.GetAllPrimitives(sorted);
    if (idx < prims.size()) return prims[idx];
    return nullptr;
}

/** Helper: get count of properties of a type. */
static size_t csGetPropertyByTypeCount(ContinuousStructure& csx, CSProperties::PropertyType type) {
    return csx.GetPropertyByType(type).size();
}

/** Helper: get property by type at index. */
static CSProperties* csGetPropertyByTypeAt(ContinuousStructure& csx, CSProperties::PropertyType type, size_t idx) {
    std::vector<CSProperties*> props = csx.GetPropertyByType(type);
    if (idx < props.size()) return props[idx];
    return nullptr;
}

// ---------------------------------------------------------------------------
// Embind registration
// ---------------------------------------------------------------------------

EMSCRIPTEN_BINDINGS(csxcad) {

    register_vector<double>("VectorDouble");

    // --- ParameterSet (opaque, needed for constructors) ---
    class_<ParameterSet>("ParameterSet");

    // --- CSRectGrid ---
    class_<CSRectGrid>("CSRectGrid")
        .function("SetDeltaUnit", &CSRectGrid::SetDeltaUnit)
        .function("GetDeltaUnit", &CSRectGrid::GetDeltaUnit)
        .function("AddDiscLine", &CSRectGrid::AddDiscLine)
        .function("GetQtyLines", &CSRectGrid::GetQtyLines)
        .function("GetLine", &CSRectGrid::GetLine)
        .function("SetLine", &CSRectGrid::SetLine)
        .function("Sort", &CSRectGrid::Sort)
        .function("clear", &CSRectGrid::clear)
        .function("GetLines", &gridGetLines)
        .function("SetLines", &gridSetLines)
        .function("ClearLines", &CSRectGrid::ClearLines)
        .function("SetMeshType", &CSRectGrid::SetMeshType)
        .function("GetMeshType", &CSRectGrid::GetMeshType)
        .function("isValid", &CSRectGrid::isValid)
        ;

    // --- CSBackgroundMaterial ---
    class_<CSBackgroundMaterial>("CSBackgroundMaterial")
        .function("SetEpsilon", &CSBackgroundMaterial::SetEpsilon)
        .function("GetEpsilon", &CSBackgroundMaterial::GetEpsilon)
        .function("SetMue", &CSBackgroundMaterial::SetMue)
        .function("GetMue", &CSBackgroundMaterial::GetMue)
        .function("SetKappa", &CSBackgroundMaterial::SetKappa)
        .function("GetKappa", &CSBackgroundMaterial::GetKappa)
        .function("SetSigma", &CSBackgroundMaterial::SetSigma)
        .function("GetSigma", &CSBackgroundMaterial::GetSigma)
        ;

    // --- CSProperties (base) ---
    class_<CSProperties>("CSProperties")
        .function("GetName", &CSProperties::GetName)
        .function("SetName", &CSProperties::SetName)
        .function("GetType", &CSProperties::GetType)
        .function("GetTypeString", &CSProperties::GetTypeString)
        .function("GetQtyPrimitives", &CSProperties::GetQtyPrimitives)
        .function("GetPrimitive", &CSProperties::GetPrimitive, allow_raw_pointers())
        .function("AddPrimitive", &CSProperties::AddPrimitive, allow_raw_pointers())
        .function("GetID", &CSProperties::GetID)
        .function("SetID", &CSProperties::SetID)
        .function("ExistAttribute", &CSProperties::ExistAttribute)
        .function("GetAttributeValue", &CSProperties::GetAttributeValue)
        .function("AddAttribute", &CSProperties::AddAttribute)
        .function("RemoveAttribute", &CSProperties::RemoveAttribute)
        .function("RemovePrimitive", &CSProperties::RemovePrimitive, allow_raw_pointers())
        .function("DeletePrimitive", &CSProperties::DeletePrimitive, allow_raw_pointers())
        .function("GetVisibility", &CSProperties::GetVisibility)
        .function("SetVisibility", &CSProperties::SetVisibility)
        ;

    // --- CSPropMetal ---
    class_<CSPropMetal, base<CSProperties>>("CSPropMetal")
        .class_function("create", &createCSPropMetal, allow_raw_pointers())
        ;

    // --- CSPropMaterial ---
    class_<CSPropMaterial, base<CSProperties>>("CSPropMaterial")
        .class_function("create", &createCSPropMaterial, allow_raw_pointers())
        .function("SetEpsilon", select_overload<void(double, int)>(&CSPropMaterial::SetEpsilon))
        .function("GetEpsilon", &CSPropMaterial::GetEpsilon)
        .function("SetMue", select_overload<void(double, int)>(&CSPropMaterial::SetMue))
        .function("GetMue", &CSPropMaterial::GetMue)
        .function("SetKappa", select_overload<void(double, int)>(&CSPropMaterial::SetKappa))
        .function("GetKappa", &CSPropMaterial::GetKappa)
        .function("SetSigma", select_overload<void(double, int)>(&CSPropMaterial::SetSigma))
        .function("GetSigma", &CSPropMaterial::GetSigma)
        .function("SetDensity", select_overload<void(double)>(&CSPropMaterial::SetDensity))
        .function("GetDensity", &CSPropMaterial::GetDensity)
        .function("SetIsotropy", &CSPropMaterial::SetIsotropy)
        .function("GetIsotropy", &CSPropMaterial::GetIsotropy)
        ;

    // --- CSPropExcitation ---
    class_<CSPropExcitation, base<CSProperties>>("CSPropExcitation")
        .class_function("create", &createCSPropExcitation, allow_raw_pointers())
        .function("SetNumber", &CSPropExcitation::SetNumber)
        .function("GetNumber", &CSPropExcitation::GetNumber)
        .function("SetExcitType", &CSPropExcitation::SetExcitType)
        .function("GetExcitType", &CSPropExcitation::GetExcitType)
        .function("SetExcitation", select_overload<void(double, int)>(&CSPropExcitation::SetExcitation))
        .function("GetExcitation", &CSPropExcitation::GetExcitation)
        .function("SetActiveDir", &CSPropExcitation::SetActiveDir)
        .function("GetActiveDir", &CSPropExcitation::GetActiveDir)
        .function("SetFrequency", select_overload<void(double)>(&CSPropExcitation::SetFrequency))
        .function("GetFrequency", &CSPropExcitation::GetFrequency)
        .function("SetDelay", select_overload<void(double)>(&CSPropExcitation::SetDelay))
        .function("GetDelay", &CSPropExcitation::GetDelay)
        .function("SetPropagationDir", select_overload<void(double, int)>(&CSPropExcitation::SetPropagationDir))
        .function("GetPropagationDir", &CSPropExcitation::GetPropagationDir)
        .function("SetWeightFunction", &CSPropExcitation::SetWeightFunction)
        .function("GetWeightFunction", &CSPropExcitation::GetWeightFunction)
        .function("SetEnabled", &CSPropExcitation::SetEnabled)
        .function("GetEnabled", &CSPropExcitation::GetEnabled)
        ;

    // --- CSPropProbeBox ---
    class_<CSPropProbeBox, base<CSProperties>>("CSPropProbeBox")
        .class_function("create", &createCSPropProbeBox, allow_raw_pointers())
        .function("SetNumber", &CSPropProbeBox::SetNumber)
        .function("GetNumber", &CSPropProbeBox::GetNumber)
        .function("SetProbeType", &CSPropProbeBox::SetProbeType)
        .function("GetProbeType", &CSPropProbeBox::GetProbeType)
        .function("SetWeighting", &CSPropProbeBox::SetWeighting)
        .function("GetWeighting", &CSPropProbeBox::GetWeighting)
        .function("SetNormalDir", &CSPropProbeBox::SetNormalDir)
        .function("GetNormalDir", &CSPropProbeBox::GetNormalDir)
        .function("AddFDSample", select_overload<void(double)>(&CSPropProbeBox::AddFDSample))
        .function("SetStartTime", &CSPropProbeBox::SetStartTime)
        .function("GetStartTime", &CSPropProbeBox::GetStartTime)
        .function("SetStopTime", &CSPropProbeBox::SetStopTime)
        .function("GetStopTime", &CSPropProbeBox::GetStopTime)
        .function("CountFDSamples", &CSPropProbeBox::CountFDSamples)
        .function("ClearFDSamples", &CSPropProbeBox::ClearFDSamples)
        ;

    // --- CSPropDumpBox ---
    class_<CSPropDumpBox, base<CSPropProbeBox>>("CSPropDumpBox")
        .class_function("create", &createCSPropDumpBox, allow_raw_pointers())
        .function("SetDumpType", &CSPropDumpBox::SetDumpType)
        .function("GetDumpType", &CSPropDumpBox::GetDumpType)
        .function("SetDumpMode", &CSPropDumpBox::SetDumpMode)
        .function("GetDumpMode", &CSPropDumpBox::GetDumpMode)
        .function("SetFileType", &CSPropDumpBox::SetFileType)
        .function("GetFileType", &CSPropDumpBox::GetFileType)
        .function("SetMultiGridLevel", &CSPropDumpBox::SetMultiGridLevel)
        .function("GetMultiGridLevel", &CSPropDumpBox::GetMultiGridLevel)
        .function("SetSubSampling", select_overload<void(bool)>(&CSPropDumpBox::SetSubSampling))
        .function("GetSubSampling", select_overload<bool()>(&CSPropDumpBox::GetSubSampling))
        .function("SetOptResolution", select_overload<void(bool)>(&CSPropDumpBox::SetOptResolution))
        .function("GetOptResolution", select_overload<bool()>(&CSPropDumpBox::GetOptResolution))
        ;

    // --- CSPropLumpedElement ---
    class_<CSPropLumpedElement, base<CSProperties>>("CSPropLumpedElement")
        .class_function("create", &createCSPropLumpedElement, allow_raw_pointers())
        .function("SetResistance", select_overload<void(double)>(&CSPropLumpedElement::SetResistance))
        .function("GetResistance", &CSPropLumpedElement::GetResistance)
        .function("SetCapacity", select_overload<void(double)>(&CSPropLumpedElement::SetCapacity))
        .function("GetCapacity", &CSPropLumpedElement::GetCapacity)
        .function("SetInductance", select_overload<void(double)>(&CSPropLumpedElement::SetInductance))
        .function("GetInductance", &CSPropLumpedElement::GetInductance)
        .function("SetDirection", &CSPropLumpedElement::SetDirection)
        .function("GetDirection", &CSPropLumpedElement::GetDirection)
        .function("SetCaps", &CSPropLumpedElement::SetCaps)
        .function("GetCaps", &CSPropLumpedElement::GetCaps)
        .function("SetLEtype", &CSPropLumpedElement::SetLEtype)
        .function("GetLEtype", &CSPropLumpedElement::GetLEtype)
        ;

    // --- CSPropConductingSheet ---
    class_<CSPropConductingSheet, base<CSPropMetal>>("CSPropConductingSheet")
        .class_function("create", &createCSPropConductingSheet, allow_raw_pointers())
        .function("SetThickness", select_overload<void(double)>(&CSPropConductingSheet::SetThickness))
        .function("GetThickness", &CSPropConductingSheet::GetThickness)
        .function("SetConductivity", select_overload<void(double)>(&CSPropConductingSheet::SetConductivity))
        .function("GetConductivity", &CSPropConductingSheet::GetConductivity)
        ;

    // --- CSPropDispersiveMaterial (abstract base for Lorentz/Debye) ---
    class_<CSPropDispersiveMaterial, base<CSPropMaterial>>("CSPropDispersiveMaterial")
        .function("GetDispersionOrder", &CSPropDispersiveMaterial::GetDispersionOrder)
        .function("SetDispersionOrder", &CSPropDispersiveMaterial::SetDispersionOrder)
        ;

    // --- CSPropLorentzMaterial ---
    class_<CSPropLorentzMaterial, base<CSPropDispersiveMaterial>>("CSPropLorentzMaterial")
        .class_function("create", &createCSPropLorentzMaterial, allow_raw_pointers())
        .function("SetEpsPlasmaFreq", select_overload<void(int, double, int)>(&CSPropLorentzMaterial::SetEpsPlasmaFreq))
        .function("GetEpsPlasmaFreq", &CSPropLorentzMaterial::GetEpsPlasmaFreq)
        .function("SetEpsLorPoleFreq", select_overload<void(int, double, int)>(&CSPropLorentzMaterial::SetEpsLorPoleFreq))
        .function("GetEpsLorPoleFreq", &CSPropLorentzMaterial::GetEpsLorPoleFreq)
        .function("SetEpsRelaxTime", select_overload<void(int, double, int)>(&CSPropLorentzMaterial::SetEpsRelaxTime))
        .function("GetEpsRelaxTime", &CSPropLorentzMaterial::GetEpsRelaxTime)
        .function("SetMuePlasmaFreq", select_overload<void(int, double, int)>(&CSPropLorentzMaterial::SetMuePlasmaFreq))
        .function("GetMuePlasmaFreq", &CSPropLorentzMaterial::GetMuePlasmaFreq)
        .function("SetMueLorPoleFreq", select_overload<void(int, double, int)>(&CSPropLorentzMaterial::SetMueLorPoleFreq))
        .function("GetMueLorPoleFreq", &CSPropLorentzMaterial::GetMueLorPoleFreq)
        .function("SetMueRelaxTime", select_overload<void(int, double, int)>(&CSPropLorentzMaterial::SetMueRelaxTime))
        .function("GetMueRelaxTime", &CSPropLorentzMaterial::GetMueRelaxTime)
        ;

    // --- CSPropDebyeMaterial ---
    class_<CSPropDebyeMaterial, base<CSPropDispersiveMaterial>>("CSPropDebyeMaterial")
        .class_function("create", &createCSPropDebyeMaterial, allow_raw_pointers())
        .function("SetEpsDelta", select_overload<void(int, double, int)>(&CSPropDebyeMaterial::SetEpsDelta))
        .function("GetEpsDelta", &CSPropDebyeMaterial::GetEpsDelta)
        .function("SetEpsRelaxTime", select_overload<void(int, double, int)>(&CSPropDebyeMaterial::SetEpsRelaxTime))
        .function("GetEpsRelaxTime", &CSPropDebyeMaterial::GetEpsRelaxTime)
        ;

    // --- CSPropDiscMaterial ---
    class_<CSPropDiscMaterial, base<CSPropMaterial>>("CSPropDiscMaterial")
        .class_function("create", &createCSPropDiscMaterial, allow_raw_pointers())
        // Note: SetFilename not exposed — m_Filename is read from XML via ReadFromXML
        ;

    // --- CSPropResBox ---
    class_<CSPropResBox, base<CSProperties>>("CSPropResBox")
        .class_function("create", &createCSPropResBox, allow_raw_pointers())
        .function("SetResFactor", &CSPropResBox::SetResFactor)
        .function("GetResFactor", &CSPropResBox::GetResFactor)
        ;

    // --- CSPrimitives (base) ---
    class_<CSPrimitives>("CSPrimitives")
        .function("GetType", &CSPrimitives::GetType)
        .function("GetTypeName", &CSPrimitives::GetTypeName)
        .function("SetPriority", &CSPrimitives::SetPriority)
        .function("GetPriority", &CSPrimitives::GetPriority)
        .function("GetID", &CSPrimitives::GetID)
        .function("SetProperty", &CSPrimitives::SetProperty, allow_raw_pointers())
        .function("GetProperty", &CSPrimitives::GetProperty, allow_raw_pointers())
        .function("GetDimension", &CSPrimitives::GetDimension)
        .function("GetPrimitiveUsed", &CSPrimitives::GetPrimitiveUsed)
        .function("SetPrimitiveUsed", &CSPrimitives::SetPrimitiveUsed)
        .function("Update", optional_override([](CSPrimitives& self) { return self.Update(nullptr); }))
        .function("ToBox", &CSPrimitives::ToBox, allow_raw_pointers())
        .function("ToCylinder", &CSPrimitives::ToCylinder, allow_raw_pointers())
        .function("ToSphere", &CSPrimitives::ToSphere, allow_raw_pointers())
        .function("ToPolygon", &CSPrimitives::ToPolygon, allow_raw_pointers())
        .function("ToCurve", &CSPrimitives::ToCurve, allow_raw_pointers())
        .function("ToWire", &CSPrimitives::ToWire, allow_raw_pointers())
        ;

    // --- CSPrimBox ---
    class_<CSPrimBox, base<CSPrimitives>>("CSPrimBox")
        .class_function("create", &createCSPrimBox, allow_raw_pointers())
        .function("SetCoord", select_overload<void(int, double)>(&CSPrimBox::SetCoord))
        .function("GetCoord", &CSPrimBox::GetCoord)
        .function("SetStartStop", &boxSetStartStop)
        ;

    // --- CSPrimCylinder ---
    class_<CSPrimCylinder, base<CSPrimitives>>("CSPrimCylinder")
        .class_function("create", &createCSPrimCylinder, allow_raw_pointers())
        .function("SetCoord", select_overload<void(int, double)>(&CSPrimCylinder::SetCoord))
        .function("GetCoord", &CSPrimCylinder::GetCoord)
        .function("SetRadius", select_overload<void(double)>(&CSPrimCylinder::SetRadius))
        .function("GetRadius", &CSPrimCylinder::GetRadius)
        .function("SetAxis", &cylinderSetAxis)
        ;

    // --- CSPrimCylindricalShell ---
    class_<CSPrimCylindricalShell, base<CSPrimCylinder>>("CSPrimCylindricalShell")
        .class_function("create", &createCSPrimCylindricalShell, allow_raw_pointers())
        .function("SetShellWidth", select_overload<void(double)>(&CSPrimCylindricalShell::SetShellWidth))
        .function("GetShellWidth", &CSPrimCylindricalShell::GetShellWidth)
        ;

    // --- CSPrimSphere ---
    class_<CSPrimSphere, base<CSPrimitives>>("CSPrimSphere")
        .class_function("create", &createCSPrimSphere, allow_raw_pointers())
        .function("SetCoord", select_overload<void(int, double)>(&CSPrimSphere::SetCoord))
        .function("GetCoord", &CSPrimSphere::GetCoord)
        .function("SetCenter", select_overload<void(double, double, double)>(&CSPrimSphere::SetCenter))
        .function("SetRadius", select_overload<void(double)>(&CSPrimSphere::SetRadius))
        .function("GetRadius", &CSPrimSphere::GetRadius)
        ;

    // --- CSPrimSphericalShell ---
    class_<CSPrimSphericalShell, base<CSPrimSphere>>("CSPrimSphericalShell")
        .class_function("create", &createCSPrimSphericalShell, allow_raw_pointers())
        .function("SetShellWidth", select_overload<void(double)>(&CSPrimSphericalShell::SetShellWidth))
        .function("GetShellWidth", &CSPrimSphericalShell::GetShellWidth)
        ;

    // --- CSPrimPolygon ---
    class_<CSPrimPolygon, base<CSPrimitives>>("CSPrimPolygon")
        .class_function("create", &createCSPrimPolygon, allow_raw_pointers())
        .function("SetNormDir", &CSPrimPolygon::SetNormDir)
        .function("GetNormDir", &CSPrimPolygon::GetNormDir)
        .function("SetElevation", select_overload<void(double)>(&CSPrimPolygon::SetElevation))
        .function("GetElevation", &CSPrimPolygon::GetElevation)
        .function("AddCoord", select_overload<void(double)>(&CSPrimPolygon::AddCoord))
        .function("SetCoord", select_overload<void(int, double)>(&CSPrimPolygon::SetCoord))
        .function("GetCoord", &CSPrimPolygon::GetCoord)
        .function("GetQtyCoords", &CSPrimPolygon::GetQtyCoords)
        .function("ClearCoords", &CSPrimPolygon::ClearCoords)
        .function("SetCoords", &polygonSetCoords)
        .function("GetCoords", &polygonGetCoords)
        ;

    // --- CSPrimLinPoly ---
    class_<CSPrimLinPoly, base<CSPrimPolygon>>("CSPrimLinPoly")
        .class_function("create", &createCSPrimLinPoly, allow_raw_pointers())
        .function("SetLength", select_overload<void(double)>(&CSPrimLinPoly::SetLength))
        .function("GetLength", &CSPrimLinPoly::GetLength)
        ;

    // --- CSPrimRotPoly ---
    class_<CSPrimRotPoly, base<CSPrimPolygon>>("CSPrimRotPoly")
        .class_function("create", &createCSPrimRotPoly, allow_raw_pointers())
        .function("SetAngle", select_overload<void(int, double)>(&CSPrimRotPoly::SetAngle))
        .function("GetAngle", &CSPrimRotPoly::GetAngle)
        .function("SetRotAxisDir", &CSPrimRotPoly::SetRotAxisDir)
        .function("GetRotAxisDir", &CSPrimRotPoly::GetRotAxisDir)
        ;

    // --- CSPrimCurve ---
    class_<CSPrimCurve, base<CSPrimitives>>("CSPrimCurve")
        .class_function("create", &createCSPrimCurve, allow_raw_pointers())
        .function("AddPoint", &curveAddPoint3)
        .function("GetPoint", &curveGetPoint)
        .function("GetNumberOfPoints", &CSPrimCurve::GetNumberOfPoints)
        .function("ClearPoints", &CSPrimCurve::ClearPoints)
        ;

    // --- CSPrimWire ---
    class_<CSPrimWire, base<CSPrimCurve>>("CSPrimWire")
        .class_function("create", &createCSPrimWire, allow_raw_pointers())
        .function("SetWireRadius", select_overload<void(double)>(&CSPrimWire::SetWireRadius))
        .function("GetWireRadius", &CSPrimWire::GetWireRadius)
        ;

    // --- CSPrimPoint ---
    class_<CSPrimPoint, base<CSPrimitives>>("CSPrimPoint")
        .class_function("create", &createCSPrimPoint, allow_raw_pointers())
        .function("SetCoord", select_overload<void(int, double)>(&CSPrimPoint::SetCoord))
        .function("GetCoord", &CSPrimPoint::GetCoord)
        ;

    // --- CSPrimMultiBox ---
    class_<CSPrimMultiBox, base<CSPrimitives>>("CSPrimMultiBox")
        .class_function("create", &createCSPrimMultiBox, allow_raw_pointers())
        .function("SetCoord", select_overload<void(int, double)>(&CSPrimMultiBox::SetCoord))
        .function("GetCoord", &CSPrimMultiBox::GetCoord)
        .function("AddBox", &CSPrimMultiBox::AddBox)
        .function("ClearOverlap", &CSPrimMultiBox::ClearOverlap)
        .function("GetQtyBoxes", &CSPrimMultiBox::GetQtyBoxes)
        ;

    // --- ContinuousStructure ---
    class_<ContinuousStructure>("ContinuousStructure")
        .constructor<>()
        .function("GetParameterSet", &ContinuousStructure::GetParameterSet, allow_raw_pointers())
        .function("GetGrid", &ContinuousStructure::GetGrid, allow_raw_pointers())
        .function("GetBackgroundMaterial", &ContinuousStructure::GetBackgroundMaterial, allow_raw_pointers())
        .function("AddProperty", &ContinuousStructure::AddProperty, allow_raw_pointers())
        .function("GetProperty", &ContinuousStructure::GetProperty, allow_raw_pointers())
        .function("GetQtyProperties", &ContinuousStructure::GetQtyProperties)
        .function("GetQtyPrimitives", select_overload<size_t(CSProperties::PropertyType)>(&ContinuousStructure::GetQtyPrimitives))
        .function("SetCoordInputType", &ContinuousStructure::SetCoordInputType)
        .function("GetCoordInputType", &ContinuousStructure::GetCoordInputType)
        .function("Update", &ContinuousStructure::Update)
        .function("clear", &ContinuousStructure::clear)
        .function("ReplaceProperty", &ContinuousStructure::ReplaceProperty, allow_raw_pointers())
        .function("RemoveProperty", &ContinuousStructure::RemoveProperty, allow_raw_pointers())
        .function("DeletePropertyByIndex", select_overload<void(size_t)>(&ContinuousStructure::DeleteProperty))
        .function("DeleteProperty", select_overload<void(CSProperties*)>(&ContinuousStructure::DeleteProperty), allow_raw_pointers())
        .function("GetPrimitiveByID", &ContinuousStructure::GetPrimitiveByID, allow_raw_pointers())
        .function("GetPropertiesByNameCount", &csGetPropertiesByNameCount)
        .function("GetPropertiesByNameAt", &csGetPropertiesByNameAt, allow_raw_pointers())
        .function("GetQtyPropertyType", &ContinuousStructure::GetQtyPropertyType)
        .function("GetIndex", &ContinuousStructure::GetIndex, allow_raw_pointers())
        .function("DeletePrimitive", &ContinuousStructure::DeletePrimitive, allow_raw_pointers())
        .function("HasPrimitive", &ContinuousStructure::HasPrimitive, allow_raw_pointers())
        .function("InsertEdges2Grid", &ContinuousStructure::InsertEdges2Grid)
        .function("isGeometryValid", &ContinuousStructure::isGeometryValid)
        .function("SetDrawingTolerance", &ContinuousStructure::SetDrawingTolerance)
        .function("GetAllPrimitivesCount", &csGetAllPrimitivesCount)
        .function("GetAllPrimitivesAt", &csGetAllPrimitivesAt, allow_raw_pointers())
        .function("GetPropertyByTypeCount", &csGetPropertyByTypeCount)
        .function("GetPropertyByTypeAt", &csGetPropertyByTypeAt, allow_raw_pointers())
        ;

    // --- Free functions ---
    function("csxToXML", &csxToXML);
    function("csxFromXML", &csxFromXML);

    // --- Enums ---
    enum_<CoordinateSystem>("CoordinateSystem")
        .value("CARTESIAN", CARTESIAN)
        .value("CYLINDRICAL", CYLINDRICAL)
        .value("UNDEFINED_CS", UNDEFINED_CS)
        ;

    enum_<CSProperties::PropertyType>("PropertyType")
        .value("ANY", CSProperties::ANY)
        .value("UNKNOWN", CSProperties::UNKNOWN)
        .value("MATERIAL", CSProperties::MATERIAL)
        .value("METAL", CSProperties::METAL)
        .value("EXCITATION", CSProperties::EXCITATION)
        .value("PROBEBOX", CSProperties::PROBEBOX)
        .value("RESBOX", CSProperties::RESBOX)
        .value("DUMPBOX", CSProperties::DUMPBOX)
        .value("DISPERSIVEMATERIAL", CSProperties::DISPERSIVEMATERIAL)
        .value("LORENTZMATERIAL", CSProperties::LORENTZMATERIAL)
        .value("DEBYEMATERIAL", CSProperties::DEBYEMATERIAL)
        .value("DISCRETE_MATERIAL", CSProperties::DISCRETE_MATERIAL)
        .value("LUMPED_ELEMENT", CSProperties::LUMPED_ELEMENT)
        .value("CONDUCTINGSHEET", CSProperties::CONDUCTINGSHEET)
        ;

    enum_<CSPrimitives::PrimitiveType>("PrimitiveType")
        .value("POINT", CSPrimitives::POINT)
        .value("BOX", CSPrimitives::BOX)
        .value("MULTIBOX", CSPrimitives::MULTIBOX)
        .value("SPHERE", CSPrimitives::SPHERE)
        .value("SPHERICALSHELL", CSPrimitives::SPHERICALSHELL)
        .value("CYLINDER", CSPrimitives::CYLINDER)
        .value("CYLINDRICALSHELL", CSPrimitives::CYLINDRICALSHELL)
        .value("POLYGON", CSPrimitives::POLYGON)
        .value("LINPOLY", CSPrimitives::LINPOLY)
        .value("ROTPOLY", CSPrimitives::ROTPOLY)
        .value("CURVE", CSPrimitives::CURVE)
        .value("WIRE", CSPrimitives::WIRE)
        .value("USERDEFINED", CSPrimitives::USERDEFINED)
        ;

    enum_<CSPropLumpedElement::LEtype>("LEtype")
        .value("PARALLEL", CSPropLumpedElement::PARALLEL)
        .value("SERIES", CSPropLumpedElement::SERIES)
        ;
}
