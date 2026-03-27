/**
 * Pre-built XML configurations for the demo examples.
 * Generated with full-precision coordinates from smoothed grids.
 */

export const PATCH_ANTENNA = `<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="30000" endCriteria="0.0001" f_max="3000000000">
    <Excitation Type="0" f0="2000000000" fc="1000000000"/>
    <BoundaryCond xmin="2" xmax="2" ymin="2" ymax="2" zmin="2" zmax="2"/>
  </FDTD>
<ContinuousStructure CoordSystem="0">
  <RectilinearGrid DeltaUnit="0.001" CoordSystem="0">
    <XLines Qty="48">-100,-95.3333333333333,-90.6666666666667,-86,-81.3333333333333,-76.6666666666667,-72,-67.3333333333333,-62.6666666666667,-58,-53.3333333333333,-48.6666666666667,-44,-39.3333333333333,-34.6666666666667,-30,-25.3333333333333,-20.6666666666667,-16,-12.6666666666667,-9.33333333333333,-6,-3,0,4,8,12,16,20.6666666666667,25.3333333333333,30,34.6666666666667,39.3333333333333,44,48.6666666666667,53.3333333333333,58,62.6666666666667,67.3333333333333,72,76.6666666666667,81.3333333333333,86,90.6666666666667,95.3333333333333,100,-6,-6</XLines>
    <YLines Qty="49">-100,-95.3333333333333,-90.6666666666667,-86,-81.3333333333333,-76.6666666666667,-72,-67.3333333333333,-62.6666666666667,-58,-53.3333333333333,-48.6666666666667,-44,-39.3333333333333,-34.6666666666667,-30,-26.6666666666667,-23.3333333333333,-20,-16,-12,-8,-4,0,4,8,12,16,20,23.3333333333333,26.6666666666667,30,34.6666666666667,39.3333333333333,44,48.6666666666667,53.3333333333333,58,62.6666666666667,67.3333333333333,72,76.6666666666667,81.3333333333333,86,90.6666666666667,95.3333333333333,100,0,0</YLines>
    <ZLines Qty="39">-50,-45.4545454545455,-40.9090909090909,-36.3636363636364,-31.8181818181818,-27.2727272727273,-22.7272727272727,-18.1818181818182,-13.6363636363636,-9.09090909090909,-4.54545454545454,0,0.381,0.762,1.143,1.524,5.762,10,14.7368421052632,19.4736842105263,24.2105263157895,28.9473684210526,33.6842105263158,38.4210526315789,43.1578947368421,47.8947368421053,52.6315789473684,57.3684210526316,62.1052631578947,66.8421052631579,71.578947368421,76.3157894736842,81.0526315789474,85.7894736842105,90.5263157894737,95.2631578947368,100,0,1.524</ZLines>
  </RectilinearGrid>
  <BackgroundMaterial Epsilon="1" Mue="1" Kappa="0" Sigma="0" />
  <ParameterSet />
  <Properties>
    <Metal ID="0" Name="gnd">
      <FillColor R="0" G="22" B="103" a="255" />
      <EdgeColor R="0" G="22" B="103" a="255" />
      <Primitives>
        <Box Priority="10">
          <P1 X="-3.0000000000000000e+01" Y="-3.0000000000000000e+01" Z="0.0000000000000000e+00" />
          <P2 X="3.0000000000000000e+01" Y="3.0000000000000000e+01" Z="0.0000000000000000e+00" />
        </Box>
      </Primitives>
    </Metal>
    <Material ID="1" Name="sub" Isotropy="1">
      <FillColor R="35" G="148" B="130" a="123" />
      <EdgeColor R="35" G="148" B="130" a="123" />
      <Primitives>
        <Box Priority="0">
          <P1 X="-3.0000000000000000e+01" Y="-3.0000000000000000e+01" Z="0.0000000000000000e+00" />
          <P2 X="3.0000000000000000e+01" Y="3.0000000000000000e+01" Z="1.5240000000000000e+00" />
        </Box>
      </Primitives>
      <Property Epsilon="3.380000e+00,1.000000e+00,1.000000e+00" Mue="1.000000e+00,1.000000e+00,1.000000e+00" Kappa="0.000000e+00,0.000000e+00,0.000000e+00" Sigma="0.000000e+00,0.000000e+00,0.000000e+00" Density="0.0000000000000000e+00" />
      <Weight Epsilon="1.000000e+00,1.000000e+00,1.000000e+00" Mue="1.000000e+00,1.000000e+00,1.000000e+00" Kappa="1.000000e+00,1.000000e+00,1.000000e+00" Sigma="1.000000e+00,1.000000e+00,1.000000e+00" Density="1.0000000000000000e+00" />
    </Material>
    <Metal ID="2" Name="patch">
      <FillColor R="218" G="188" B="236" a="255" />
      <EdgeColor R="218" G="188" B="236" a="255" />
      <Primitives>
        <Box Priority="10">
          <P1 X="-1.6000000000000000e+01" Y="-2.0000000000000000e+01" Z="1.5240000000000000e+00" />
          <P2 X="1.6000000000000000e+01" Y="2.0000000000000000e+01" Z="1.5240000000000000e+00" />
        </Box>
      </Primitives>
    </Metal>
    <LumpedElement ID="3" Name="port_resist_1" Direction="2" Caps="1" R="5.0000000000000000e+01" C="nan" L="nan" LEtype="-1.0000000000000000e+00">
      <FillColor R="52" G="83" B="255" a="255" />
      <EdgeColor R="52" G="83" B="255" a="255" />
      <Primitives>
        <Box Priority="5">
          <P1 X="-6.0000000000000000e+00" Y="0.0000000000000000e+00" Z="0.0000000000000000e+00" />
          <P2 X="-6.0000000000000000e+00" Y="0.0000000000000000e+00" Z="1.5240000000000000e+00" />
        </Box>
      </Primitives>
    </LumpedElement>
    <Excitation ID="4" Name="port_excite_1" Number="0" Enabled="1" Frequency="0.0000000000000000e+00" Delay="0.0000000000000000e+00" Type="0" Excite="0.000000e+00,0.000000e+00,-1.000000e+00" PropDir="0.000000e+00,0.000000e+00,0.000000e+00">
      <FillColor R="31" G="149" B="120" a="255" />
      <EdgeColor R="31" G="149" B="120" a="255" />
      <Primitives>
        <Box Priority="5">
          <P1 X="-6.0000000000000000e+00" Y="0.0000000000000000e+00" Z="0.0000000000000000e+00" />
          <P2 X="-6.0000000000000000e+00" Y="0.0000000000000000e+00" Z="1.5240000000000000e+00" />
        </Box>
      </Primitives>
      <Weight X="1.0000000000000000e+00" Y="1.0000000000000000e+00" Z="1.0000000000000000e+00" />
    </Excitation>
    <ProbeBox ID="5" Name="port_ut_1" Number="0" Type="0" Weight="-1" NormDir="-1" StartTime="0" StopTime="0">
      <FillColor R="254" G="236" B="189" a="255" />
      <EdgeColor R="254" G="236" B="189" a="255" />
      <Primitives>
        <Box Priority="0">
          <P1 X="-6.0000000000000000e+00" Y="0.0000000000000000e+00" Z="0.0000000000000000e+00" />
          <P2 X="-6.0000000000000000e+00" Y="0.0000000000000000e+00" Z="1.5240000000000000e+00" />
        </Box>
      </Primitives>
    </ProbeBox>
    <ProbeBox ID="6" Name="port_it_1" Number="0" NormDir="2" Type="1" Weight="1" StartTime="0" StopTime="0">
      <FillColor R="203" G="4" B="22" a="255" />
      <EdgeColor R="203" G="4" B="22" a="255" />
      <Primitives>
        <Box Priority="0">
          <P1 X="-6.0000000000000000e+00" Y="0.0000000000000000e+00" Z="7.6200000000000001e-01" />
          <P2 X="-6.0000000000000000e+00" Y="0.0000000000000000e+00" Z="7.6200000000000001e-01" />
        </Box>
      </Primitives>
    </ProbeBox>
  </Properties>
</ContinuousStructure>

</openEMS>`;


export const MSL_NOTCH_FILTER = `<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="20000" endCriteria="1e-5" f_max="10e9">
    <Excitation Type="0" f0="5e9" fc="5e9"/>
    <BoundaryCond xmin="3" xmax="3" ymin="3" ymax="3" zmin="0" zmax="3"
                  PML_xmin="8" PML_xmax="8" PML_ymin="8" PML_ymax="8" PML_zmin="0" PML_zmax="8"/>
  </FDTD>
  <ContinuousStructure CoordSystem="0">
    <RectilinearGrid DeltaUnit="1e-3">
      <XLines>-20,-18,-16,-14,-12,-10,-8,-6,-5,-4,-3,-2,-1.5,-1,-0.5,0,0.5,1,1.5,2,3,4,5,6,8,10,12,14,16,18,20</XLines>
      <YLines>-15,-12,-10,-8,-6,-4,-3,-2,-1.5,-1,-0.5,0,0.5,1,1.5,2,3,4,5,6,7,8,9,10,12,15</YLines>
      <ZLines>-5,-3,-1,0,0.254,0.508,1.0,1.524,2,3,5,8,12</ZLines>
    </RectilinearGrid>
    <Properties>
      <Metal Name="ground">
        <Primitives>
          <Box Priority="10">
            <P1 X="-20" Y="-15" Z="0"/>
            <P2 X="20" Y="15" Z="0"/>
          </Box>
        </Primitives>
      </Metal>
      <Material Name="substrate">
        <Property Epsilon="3.38"/>
        <Primitives>
          <Box Priority="5">
            <P1 X="-20" Y="-15" Z="0"/>
            <P2 X="20" Y="15" Z="1.524"/>
          </Box>
        </Primitives>
      </Material>
      <Metal Name="msl_trace">
        <Primitives>
          <Box Priority="10">
            <P1 X="-20" Y="-1.5" Z="1.524"/>
            <P2 X="20" Y="1.5" Z="1.524"/>
          </Box>
        </Primitives>
      </Metal>
      <Metal Name="notch_stub">
        <Primitives>
          <Box Priority="10">
            <P1 X="-1.5" Y="1.5" Z="1.524"/>
            <P2 X="1.5" Y="10" Z="1.524"/>
          </Box>
        </Primitives>
      </Metal>
      <LumpedElement Name="port_resist_1" Direction="2" R="50" C="0" L="0">
        <Primitives>
          <Box Priority="5">
            <P1 X="-18" Y="0" Z="0"/>
            <P2 X="-18" Y="0" Z="1.524"/>
          </Box>
        </Primitives>
      </LumpedElement>
      <Excitation Name="port_excite_1" Type="0" Excite="0,0,1">
        <Primitives>
          <Box Priority="5">
            <P1 X="-18" Y="0" Z="0"/>
            <P2 X="-18" Y="0" Z="1.524"/>
          </Box>
        </Primitives>
      </Excitation>
      <ProbeBox Name="port_ut1" Type="0" Weight="1">
        <Primitives>
          <Box Priority="0">
            <P1 X="-18" Y="0" Z="0"/>
            <P2 X="-18" Y="0" Z="1.524"/>
          </Box>
        </Primitives>
      </ProbeBox>
      <ProbeBox Name="port_it1" Type="1" Weight="1" NormDir="2">
        <Primitives>
          <Box Priority="0">
            <P1 X="-19" Y="-2" Z="0.762"/>
            <P2 X="-17" Y="2" Z="0.762"/>
          </Box>
        </Primitives>
      </ProbeBox>
      <LumpedElement Name="port_resist_2" Direction="2" R="50" C="0" L="0">
        <Primitives>
          <Box Priority="5">
            <P1 X="18" Y="0" Z="0"/>
            <P2 X="18" Y="0" Z="1.524"/>
          </Box>
        </Primitives>
      </LumpedElement>
      <ProbeBox Name="port_ut2" Type="0" Weight="1">
        <Primitives>
          <Box Priority="0">
            <P1 X="18" Y="0" Z="0"/>
            <P2 X="18" Y="0" Z="1.524"/>
          </Box>
        </Primitives>
      </ProbeBox>
      <ProbeBox Name="port_it2" Type="1" Weight="1" NormDir="2">
        <Primitives>
          <Box Priority="0">
            <P1 X="17" Y="-2" Z="0.762"/>
            <P2 X="19" Y="2" Z="0.762"/>
          </Box>
        </Primitives>
      </ProbeBox>
    </Properties>
  </ContinuousStructure>
</openEMS>`;

/**
 * Rectangular Waveguide example.
 *
 * WR-90 waveguide (22.86 x 10.16 mm) with TE10 mode port.
 * PEC walls, PML termination at both ends.
 * Gaussian excitation covering 8-12 GHz (X-band).
 */
export const RECT_WAVEGUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="10000" endCriteria="1e-5" f_max="12e9">
    <Excitation Type="0" f0="10e9" fc="2e9"/>
    <BoundaryCond xmin="3" xmax="3" ymin="0" ymax="0" zmin="0" zmax="0"
                  PML_xmin="8" PML_xmax="8" PML_ymin="0" PML_ymax="0" PML_zmin="0" PML_zmax="0"/>
  </FDTD>
  <ContinuousStructure CoordSystem="0">
    <RectilinearGrid DeltaUnit="1e-3">
      <XLines>-30,-25,-20,-15,-12,-10,-8,-6,-4,-2,0,2,4,6,8,10,12,15,20,25,30</XLines>
      <YLines>0,1.016,2.032,3.048,4.064,5.08,6.096,7.112,8.128,9.144,10.16,11.43,12.7,14,16,18,20,22.86</YLines>
      <ZLines>0,1.27,2.54,3.81,5.08,6.35,7.62,8.89,10.16</ZLines>
    </RectilinearGrid>
    <Properties>
      <Metal Name="wg_walls">
        <Primitives>
          <Box Priority="10">
            <P1 X="-30" Y="0" Z="0"/>
            <P2 X="30" Y="0" Z="10.16"/>
          </Box>
          <Box Priority="10">
            <P1 X="-30" Y="22.86" Z="0"/>
            <P2 X="30" Y="22.86" Z="10.16"/>
          </Box>
          <Box Priority="10">
            <P1 X="-30" Y="0" Z="0"/>
            <P2 X="30" Y="22.86" Z="0"/>
          </Box>
          <Box Priority="10">
            <P1 X="-30" Y="0" Z="10.16"/>
            <P2 X="30" Y="22.86" Z="10.16"/>
          </Box>
        </Primitives>
      </Metal>
      <Excitation Name="port_excite_1" Type="0" Excite="0,1,0">
        <Primitives>
          <Box Priority="5">
            <P1 X="-20" Y="0" Z="0"/>
            <P2 X="-20" Y="22.86" Z="10.16"/>
          </Box>
        </Primitives>
      </Excitation>
      <ProbeBox Name="port_ut1" Type="0" Weight="1">
        <Primitives>
          <Box Priority="0">
            <P1 X="-20" Y="0" Z="5.08"/>
            <P2 X="-20" Y="22.86" Z="5.08"/>
          </Box>
        </Primitives>
      </ProbeBox>
      <ProbeBox Name="port_it1" Type="1" Weight="1" NormDir="0">
        <Primitives>
          <Box Priority="0">
            <P1 X="-20" Y="0" Z="0"/>
            <P2 X="-20" Y="22.86" Z="10.16"/>
          </Box>
        </Primitives>
      </ProbeBox>
      <ProbeBox Name="port_ut2" Type="0" Weight="1">
        <Primitives>
          <Box Priority="0">
            <P1 X="20" Y="0" Z="5.08"/>
            <P2 X="20" Y="22.86" Z="5.08"/>
          </Box>
        </Primitives>
      </ProbeBox>
      <ProbeBox Name="port_it2" Type="1" Weight="1" NormDir="0">
        <Primitives>
          <Box Priority="0">
            <P1 X="20" Y="0" Z="0"/>
            <P2 X="20" Y="22.86" Z="10.16"/>
          </Box>
        </Primitives>
      </ProbeBox>
    </Properties>
  </ContinuousStructure>
</openEMS>`;
