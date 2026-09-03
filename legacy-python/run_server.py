import sys
sys.path.insert(0, '.')
from src.shared.transport import init_bus
init_bus()
from uvicorn import run
from src.server.api import app
run(app, host='0.0.0.0', port=8855, log_level='info')
