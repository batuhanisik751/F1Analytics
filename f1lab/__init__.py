"""f1lab — a small toolkit for Formula 1 pace analysis.

The layering is deliberate and worth preserving as the project grows:

    clean  ->  which laps are worth looking at at all
    pace   ->  removing fuel and tyre effects from those laps
    plots  ->  showing what is left
    config ->  every assumption, in one visible place

Nothing downstream should ever touch a raw lap time. If a new analysis needs one,
that is a signal the cleaning layer is missing a rule.

The ingest side (``derive``, ``colours``, ``assumptions``, ``frames``, ``db``,
``season``, ``ingest``) is imported explicitly by its users; ``db``/``ingest`` need
psycopg, which the notebook does not, so they are deliberately NOT imported here.
"""

__version__ = "0.2.0"

from . import clean, config, pace, plots  # noqa: F401,E402

__all__ = ["clean", "pace", "plots", "config", "__version__"]
