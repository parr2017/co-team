"""Co-Team server launcher for project-launcher skill."""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from src.shared.transport import init_bus
init_bus()

from uvicorn import run
from src.server.api import app
run(app, host="0.0.0.0", port=8855, log_level="info")
