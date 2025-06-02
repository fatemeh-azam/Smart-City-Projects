Crazyflie Trajectory Segment Format (7th-Order Polynomial)

Each row of the trajectory array represents a segment, and the drone's position is defined by a 7th-order polynomial for x, y, and z over time t.

Each segment looks like this:

[start_time, duration,

 x0, x1, x2, x3, x4, x5, x6, x7,

 y0, y1, y2, y3, y4, y5, y6, y7,
 
 z0, z1, z2, z3, z4, z5, z6, z7]

Total columns = 2 (time) + 3×8 (x, y, z coefficients) = 26 columns

 What Each Field Means

•	start_time: when this segment begins

•	duration: how long this segment lasts

For each axis (x, y, z), there are 8 coefficients:

•	x0 to x7: coefficients for x(t)

•	y0 to y7: coefficients for y(t)

•	z0 to z7: coefficients for z(t)

Each is used in a 7th-degree polynomial:

x(t) = x0 + x1*t + x2*t² + x3*t³ + x4*t⁴ + x5*t⁵ + x6*t⁶ + x7*t⁷

y(t) = y0 + y1*t + y2*t² + ... + y7*t⁷

z(t) = z0 + z1*t + z2*t² + ... + z7*t⁷

Where t is the local time within that segment:

0 ≤ t ≤ duration
