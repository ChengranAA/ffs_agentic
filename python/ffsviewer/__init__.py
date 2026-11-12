"""FFS Harness viewer sidecar: authoritative FFS viewer state over stdio JSON.

The browser and the agent both reach this process through the Host plugin's single
validated command interface. Nothing here re-implements FFS science: slices come from
``fastfuncstuff.viewer.compose``, coordinates from ``slicing``, surface sampling from
``surface.profiles`` + ``surface3d``, series from ``ViewerSession``.
"""

__version__ = "0.1.0"
