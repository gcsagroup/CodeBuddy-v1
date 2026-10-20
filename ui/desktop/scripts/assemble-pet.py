"""Development entry point; shipped pet assembly has one implementation."""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).resolve().parents[3] / 'runtime/assets/assemble-pet.py'), run_name='__main__')
