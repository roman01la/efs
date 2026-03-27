/**
 * Pre-built XML configurations for the demo examples.
 *
 * Each is a complete openEMS XML string that can be loaded directly
 * into the simulation engine.
 */

/**
 * Patch Antenna example.
 *
 * 32.86 x 41.37 mm patch on FR4 substrate (epsilon_r = 3.38, 1.524 mm thick).
 * 60 x 60 mm ground plane. Lumped port feed at x = -5.5 mm, 50 Ohm.
 * Gaussian excitation 0-6 GHz, 30000 timesteps, end criteria 1e-5.
 */
export const PATCH_ANTENNA = `<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="30000" endCriteria="1e-5" f_max="6e9">
    <Excitation Type="0" f0="3e9" fc="3e9"/>
    <BoundaryCond xmin="2" xmax="2" ymin="2" ymax="2" zmin="2" zmax="2"/>
  </FDTD>
  <ContinuousStructure CoordSystem="0">
    <RectilinearGrid DeltaUnit="1e-3">
      <XLines>-45,-40,-35,-32,-30,-28,-26,-24,-22,-20,-18,-16.43,-14,-12,-10,-8,-6.5,-6,-5.5,-5,-4,-2,0,2,4,5,5.5,6,6.5,8,10,12,14,16.43,18,20,22,24,26,28,30,32,35,40,45</XLines>
      <YLines>-45,-40,-35,-32,-30,-28,-26,-24,-22,-20.685,-18,-16,-14,-12,-10,-8,-6,-4,-2,0,2,4,6,8,10,12,14,16,18,20.685,22,24,26,28,30,32,35,40,45</YLines>
      <ZLines>-10,-8,-6,-4,-2,0,0.3,0.762,1.524,2,4,6,8,10,12,15,20</ZLines>
    </RectilinearGrid>
    <Properties>
      <Metal Name="ground">
        <Primitives>
          <Box Priority="10">
            <P1 X="-30" Y="-30" Z="0"/>
            <P2 X="30" Y="30" Z="0"/>
          </Box>
        </Primitives>
      </Metal>
      <Material Name="substrate">
        <Property Epsilon="3.38"/>
        <Primitives>
          <Box Priority="5">
            <P1 X="-30" Y="-30" Z="0"/>
            <P2 X="30" Y="30" Z="1.524"/>
          </Box>
        </Primitives>
      </Material>
      <Metal Name="patch">
        <Primitives>
          <Box Priority="10">
            <P1 X="-16.43" Y="-20.685" Z="1.524"/>
            <P2 X="16.43" Y="20.685" Z="1.524"/>
          </Box>
        </Primitives>
      </Metal>
      <LumpedElement Name="port_resist_1" Direction="2" R="50" C="0" L="0">
        <Primitives>
          <Box Priority="5">
            <P1 X="-5.5" Y="0" Z="0"/>
            <P2 X="-5.5" Y="0" Z="1.524"/>
          </Box>
        </Primitives>
      </LumpedElement>
      <Excitation Name="port_excite_1" Type="0" Excite="0,0,1">
        <Primitives>
          <Box Priority="5">
            <P1 X="-5.5" Y="0" Z="0"/>
            <P2 X="-5.5" Y="0" Z="1.524"/>
          </Box>
        </Primitives>
      </Excitation>
      <ProbeBox Name="port_ut1" Type="0" Weight="-1">
        <Primitives>
          <Box Priority="0">
            <P1 X="-5.5" Y="0" Z="0"/>
            <P2 X="-5.5" Y="0" Z="1.524"/>
          </Box>
        </Primitives>
      </ProbeBox>
      <ProbeBox Name="port_it1" Type="1" Weight="1" NormDir="2">
        <Primitives>
          <Box Priority="0">
            <P1 X="-6.5" Y="-2" Z="0.762"/>
            <P2 X="-4.5" Y="2" Z="0.762"/>
          </Box>
        </Primitives>
      </ProbeBox>
      <DumpBox Name="nf2ff_E" DumpType="10" DumpMode="1" FileType="1">
        <FD_Samples>2.4e9</FD_Samples>
        <Primitives>
          <Box Priority="0"><P1 X="-35" Y="-35" Z="-6"/><P2 X="-35" Y="35" Z="15"/></Box>
          <Box Priority="0"><P1 X="35" Y="-35" Z="-6"/><P2 X="35" Y="35" Z="15"/></Box>
          <Box Priority="0"><P1 X="-35" Y="-35" Z="-6"/><P2 X="35" Y="-35" Z="15"/></Box>
          <Box Priority="0"><P1 X="-35" Y="35" Z="-6"/><P2 X="35" Y="35" Z="15"/></Box>
          <Box Priority="0"><P1 X="-35" Y="-35" Z="-6"/><P2 X="35" Y="35" Z="-6"/></Box>
          <Box Priority="0"><P1 X="-35" Y="-35" Z="15"/><P2 X="35" Y="35" Z="15"/></Box>
        </Primitives>
      </DumpBox>
      <DumpBox Name="nf2ff_H" DumpType="11" DumpMode="1" FileType="1">
        <FD_Samples>2.4e9</FD_Samples>
        <Primitives>
          <Box Priority="0"><P1 X="-35" Y="-35" Z="-6"/><P2 X="-35" Y="35" Z="15"/></Box>
          <Box Priority="0"><P1 X="35" Y="-35" Z="-6"/><P2 X="35" Y="35" Z="15"/></Box>
          <Box Priority="0"><P1 X="-35" Y="-35" Z="-6"/><P2 X="35" Y="-35" Z="15"/></Box>
          <Box Priority="0"><P1 X="-35" Y="35" Z="-6"/><P2 X="35" Y="35" Z="15"/></Box>
          <Box Priority="0"><P1 X="-35" Y="-35" Z="-6"/><P2 X="35" Y="35" Z="-6"/></Box>
          <Box Priority="0"><P1 X="-35" Y="-35" Z="15"/><P2 X="35" Y="35" Z="15"/></Box>
        </Primitives>
      </DumpBox>
    </Properties>
  </ContinuousStructure>
</openEMS>`;

/**
 * MSL Notch Filter example.
 *
 * Microstrip line with a notch (quarter-wave stub) on FR4 substrate.
 * Two MSL ports for S11/S21 measurement.
 * Gaussian excitation 0-10 GHz.
 */
export const MSL_NOTCH_FILTER = `<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="20000" endCriteria="1e-5" f_max="10e9">
    <Excitation Type="0" f0="5e9" fc="5e9"/>
    <BoundaryCond xmin="2" xmax="2" ymin="2" ymax="2" zmin="0" zmax="2"/>
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
      <ProbeBox Name="port_ut1" Type="0" Weight="-1">
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
      <ProbeBox Name="port_ut2" Type="0" Weight="-1">
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
/**
 * Helical Antenna example.
 *
 * Based on https://docs.openems.de/python/openEMS/Tutorials/Helical_Antenna.html
 * 9-turn axial-mode helix at 2.4 GHz. Radius 20 mm, pitch 30 mm.
 * Circular ground plane (r = 62.5 mm). Feed impedance 120 Ohm.
 * Gaussian excitation 1.9-2.9 GHz, MUR boundaries + PML on zmax.
 */
export const HELICAL_ANTENNA = `<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="30000" endCriteria="1e-4" f_max="2.9e9">
    <Excitation Type="0" f0="2.4e9" fc="0.5e9"/>
    <BoundaryCond xmin="2" xmax="2" ymin="2" ymax="2" zmin="2" zmax="2"/>
  </FDTD>
  <ContinuousStructure CoordSystem="0">
    <RectilinearGrid DeltaUnit="1e-3">
      <XLines>-130,-110,-90,-75,-62.5,-50,-40,-30,-25,-20,-15,-10,-5,0,5,10,15,20,25,30,40,50,62.5,75,90,110,130</XLines>
      <YLines>-130,-110,-90,-75,-62.5,-50,-40,-30,-25,-20,-15,-10,-5,0,5,10,15,20,25,30,40,50,62.5,75,90,110,130</YLines>
      <ZLines>-130,-100,-70,-40,-20,-10,-5,0,1.5,3,15,30,45,60,75,90,105,120,135,150,165,180,195,210,225,240,255,270,285,300,320,350,400</ZLines>
    </RectilinearGrid>
    <Properties>
      <Metal Name="helix">
        <Primitives>
          <Curve Priority="5">
            <Vertex X="20.00" Y="0.00" Z="3.00"/>
            <Vertex X="16.18" Y="11.76" Z="6.00"/>
            <Vertex X="6.18" Y="19.02" Z="9.00"/>
            <Vertex X="-6.18" Y="19.02" Z="12.00"/>
            <Vertex X="-16.18" Y="11.76" Z="15.00"/>
            <Vertex X="-20.00" Y="0.00" Z="18.00"/>
            <Vertex X="-16.18" Y="-11.76" Z="21.00"/>
            <Vertex X="-6.18" Y="-19.02" Z="24.00"/>
            <Vertex X="6.18" Y="-19.02" Z="27.00"/>
            <Vertex X="16.18" Y="-11.76" Z="30.00"/>
            <Vertex X="20.00" Y="0.00" Z="33.00"/>
            <Vertex X="16.18" Y="11.76" Z="36.00"/>
            <Vertex X="6.18" Y="19.02" Z="39.00"/>
            <Vertex X="-6.18" Y="19.02" Z="42.00"/>
            <Vertex X="-16.18" Y="11.76" Z="45.00"/>
            <Vertex X="-20.00" Y="0.00" Z="48.00"/>
            <Vertex X="-16.18" Y="-11.76" Z="51.00"/>
            <Vertex X="-6.18" Y="-19.02" Z="54.00"/>
            <Vertex X="6.18" Y="-19.02" Z="57.00"/>
            <Vertex X="16.18" Y="-11.76" Z="60.00"/>
            <Vertex X="20.00" Y="0.00" Z="63.00"/>
            <Vertex X="16.18" Y="11.76" Z="66.00"/>
            <Vertex X="6.18" Y="19.02" Z="69.00"/>
            <Vertex X="-6.18" Y="19.02" Z="72.00"/>
            <Vertex X="-16.18" Y="11.76" Z="75.00"/>
            <Vertex X="-20.00" Y="0.00" Z="78.00"/>
            <Vertex X="-16.18" Y="-11.76" Z="81.00"/>
            <Vertex X="-6.18" Y="-19.02" Z="84.00"/>
            <Vertex X="6.18" Y="-19.02" Z="87.00"/>
            <Vertex X="16.18" Y="-11.76" Z="90.00"/>
            <Vertex X="20.00" Y="0.00" Z="93.00"/>
            <Vertex X="16.18" Y="11.76" Z="96.00"/>
            <Vertex X="6.18" Y="19.02" Z="99.00"/>
            <Vertex X="-6.18" Y="19.02" Z="102.00"/>
            <Vertex X="-16.18" Y="11.76" Z="105.00"/>
            <Vertex X="-20.00" Y="0.00" Z="108.00"/>
            <Vertex X="-16.18" Y="-11.76" Z="111.00"/>
            <Vertex X="-6.18" Y="-19.02" Z="114.00"/>
            <Vertex X="6.18" Y="-19.02" Z="117.00"/>
            <Vertex X="16.18" Y="-11.76" Z="120.00"/>
            <Vertex X="20.00" Y="0.00" Z="123.00"/>
            <Vertex X="16.18" Y="11.76" Z="126.00"/>
            <Vertex X="6.18" Y="19.02" Z="129.00"/>
            <Vertex X="-6.18" Y="19.02" Z="132.00"/>
            <Vertex X="-16.18" Y="11.76" Z="135.00"/>
            <Vertex X="-20.00" Y="0.00" Z="138.00"/>
            <Vertex X="-16.18" Y="-11.76" Z="141.00"/>
            <Vertex X="-6.18" Y="-19.02" Z="144.00"/>
            <Vertex X="6.18" Y="-19.02" Z="147.00"/>
            <Vertex X="16.18" Y="-11.76" Z="150.00"/>
            <Vertex X="20.00" Y="0.00" Z="153.00"/>
            <Vertex X="16.18" Y="11.76" Z="156.00"/>
            <Vertex X="6.18" Y="19.02" Z="159.00"/>
            <Vertex X="-6.18" Y="19.02" Z="162.00"/>
            <Vertex X="-16.18" Y="11.76" Z="165.00"/>
            <Vertex X="-20.00" Y="0.00" Z="168.00"/>
            <Vertex X="-16.18" Y="-11.76" Z="171.00"/>
            <Vertex X="-6.18" Y="-19.02" Z="174.00"/>
            <Vertex X="6.18" Y="-19.02" Z="177.00"/>
            <Vertex X="16.18" Y="-11.76" Z="180.00"/>
            <Vertex X="20.00" Y="0.00" Z="183.00"/>
            <Vertex X="16.18" Y="11.76" Z="186.00"/>
            <Vertex X="6.18" Y="19.02" Z="189.00"/>
            <Vertex X="-6.18" Y="19.02" Z="192.00"/>
            <Vertex X="-16.18" Y="11.76" Z="195.00"/>
            <Vertex X="-20.00" Y="0.00" Z="198.00"/>
            <Vertex X="-16.18" Y="-11.76" Z="201.00"/>
            <Vertex X="-6.18" Y="-19.02" Z="204.00"/>
            <Vertex X="6.18" Y="-19.02" Z="207.00"/>
            <Vertex X="16.18" Y="-11.76" Z="210.00"/>
            <Vertex X="20.00" Y="0.00" Z="213.00"/>
            <Vertex X="16.18" Y="11.76" Z="216.00"/>
            <Vertex X="6.18" Y="19.02" Z="219.00"/>
            <Vertex X="-6.18" Y="19.02" Z="222.00"/>
            <Vertex X="-16.18" Y="11.76" Z="225.00"/>
            <Vertex X="-20.00" Y="0.00" Z="228.00"/>
            <Vertex X="-16.18" Y="-11.76" Z="231.00"/>
            <Vertex X="-6.18" Y="-19.02" Z="234.00"/>
            <Vertex X="6.18" Y="-19.02" Z="237.00"/>
            <Vertex X="16.18" Y="-11.76" Z="240.00"/>
            <Vertex X="20.00" Y="0.00" Z="243.00"/>
            <Vertex X="16.18" Y="11.76" Z="246.00"/>
            <Vertex X="6.18" Y="19.02" Z="249.00"/>
            <Vertex X="-6.18" Y="19.02" Z="252.00"/>
            <Vertex X="-16.18" Y="11.76" Z="255.00"/>
            <Vertex X="-20.00" Y="0.00" Z="258.00"/>
            <Vertex X="-16.18" Y="-11.76" Z="261.00"/>
            <Vertex X="-6.18" Y="-19.02" Z="264.00"/>
            <Vertex X="6.18" Y="-19.02" Z="267.00"/>
            <Vertex X="16.18" Y="-11.76" Z="270.00"/>
            <Vertex X="20.00" Y="0.00" Z="273.00"/>
          </Curve>
        </Primitives>
      </Metal>
      <Metal Name="gnd">
        <Primitives>
          <Cylinder Priority="10" Radius="62.5">
            <P1 X="0" Y="0" Z="-0.1"/>
            <P2 X="0" Y="0" Z="0.1"/>
          </Cylinder>
        </Primitives>
      </Metal>
      <LumpedElement Name="port_resist_1" Direction="2" R="120" C="0" L="0">
        <Primitives>
          <Box Priority="5">
            <P1 X="20" Y="0" Z="0"/>
            <P2 X="20" Y="0" Z="3"/>
          </Box>
        </Primitives>
      </LumpedElement>
      <Excitation Name="port_excite_1" Type="0" Excite="0,0,1">
        <Primitives>
          <Box Priority="5">
            <P1 X="20" Y="0" Z="0"/>
            <P2 X="20" Y="0" Z="3"/>
          </Box>
        </Primitives>
      </Excitation>
      <ProbeBox Name="port_ut1" Type="0" Weight="-1">
        <Primitives>
          <Box Priority="0">
            <P1 X="20" Y="0" Z="0"/>
            <P2 X="20" Y="0" Z="3"/>
          </Box>
        </Primitives>
      </ProbeBox>
      <ProbeBox Name="port_it1" Type="1" Weight="1" NormDir="2">
        <Primitives>
          <Box Priority="0">
            <P1 X="15" Y="-5" Z="1.5"/>
            <P2 X="25" Y="5" Z="1.5"/>
          </Box>
        </Primitives>
      </ProbeBox>
      <DumpBox Name="nf2ff_E" DumpType="10" DumpMode="1" FileType="1">
        <FD_Samples>2.4e9</FD_Samples>
        <Primitives>
          <Box Priority="0"><P1 X="-90" Y="-90" Z="-40"/><P2 X="-90" Y="90" Z="320"/></Box>
          <Box Priority="0"><P1 X="90" Y="-90" Z="-40"/><P2 X="90" Y="90" Z="320"/></Box>
          <Box Priority="0"><P1 X="-90" Y="-90" Z="-40"/><P2 X="90" Y="-90" Z="320"/></Box>
          <Box Priority="0"><P1 X="-90" Y="90" Z="-40"/><P2 X="90" Y="90" Z="320"/></Box>
          <Box Priority="0"><P1 X="-90" Y="-90" Z="-40"/><P2 X="90" Y="90" Z="-40"/></Box>
          <Box Priority="0"><P1 X="-90" Y="-90" Z="320"/><P2 X="90" Y="90" Z="320"/></Box>
        </Primitives>
      </DumpBox>
      <DumpBox Name="nf2ff_H" DumpType="11" DumpMode="1" FileType="1">
        <FD_Samples>2.4e9</FD_Samples>
        <Primitives>
          <Box Priority="0"><P1 X="-90" Y="-90" Z="-40"/><P2 X="-90" Y="90" Z="320"/></Box>
          <Box Priority="0"><P1 X="90" Y="-90" Z="-40"/><P2 X="90" Y="90" Z="320"/></Box>
          <Box Priority="0"><P1 X="-90" Y="-90" Z="-40"/><P2 X="90" Y="-90" Z="320"/></Box>
          <Box Priority="0"><P1 X="-90" Y="90" Z="-40"/><P2 X="90" Y="90" Z="320"/></Box>
          <Box Priority="0"><P1 X="-90" Y="-90" Z="-40"/><P2 X="90" Y="90" Z="-40"/></Box>
          <Box Priority="0"><P1 X="-90" Y="-90" Z="320"/><P2 X="90" Y="90" Z="320"/></Box>
        </Primitives>
      </DumpBox>
    </Properties>
  </ContinuousStructure>
</openEMS>`;

export const RECT_WAVEGUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<openEMS>
  <FDTD NumberOfTimesteps="10000" endCriteria="1e-5" f_max="12e9">
    <Excitation Type="0" f0="10e9" fc="2e9"/>
    <BoundaryCond xmin="2" xmax="2" ymin="0" ymax="0" zmin="0" zmax="0"/>
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
      <ProbeBox Name="port_ut1" Type="0" Weight="-1">
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
      <ProbeBox Name="port_ut2" Type="0" Weight="-1">
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
