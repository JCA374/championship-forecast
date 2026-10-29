# Championship forecast

EFL Championship season forecast that runs in your browser: a Dixon-Coles model fitted on Premier League,
Championship and League One results, then thousands of simulated seasons including the playoffs.

```bash
python scripts/export_site_data.py --fetch   # refresh data
python -m http.server -d site 8000           # open http://localhost:8000
```

How the model works and how well it does: [docs/model.md](docs/model.md).
Adapted from [allsvenskan-v2](https://github.com/JCA374/allsvenskan-v2).
