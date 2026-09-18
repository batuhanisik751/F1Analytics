"""The ``annotate_laps`` refactor must not move a single number.

``tests/legacy_clean.py`` is a verbatim copy of the pre-refactor functions; the
live ``clean_laps`` must be byte-equal to it in columns, order, dtypes, values and
index, for both ``drop_outliers`` values, on all three fixtures.
"""

from __future__ import annotations

import pandas as pd
import pytest

from f1lab import clean
from tests import legacy_clean as legacy

ANNOTATION_COLUMNS = [
    "LapTimeSeconds",
    "excl_no_time", "excl_in_lap", "excl_out_lap", "excl_not_green",
    "excl_inaccurate", "excl_deleted",
    "is_clean", "is_outlier", "is_representative",
]


@pytest.mark.parametrize("drop_outliers", [True, False])
def test_clean_laps_byte_equal_to_legacy(any_session, drop_outliers):
    new = clean.clean_laps(any_session, drop_outliers=drop_outliers)
    old = legacy.clean_laps(any_session, drop_outliers=drop_outliers)
    assert list(new.columns) == list(old.columns)
    pd.testing.assert_frame_equal(new, old, check_dtype=True, check_index_type=True,
                                  check_column_type=True, check_exact=True)


def test_exclusion_report_equal_to_legacy(any_session):
    pd.testing.assert_frame_equal(clean.exclusion_report(any_session),
                                  legacy.exclusion_report(any_session), check_exact=True)


def test_annotate_laps_covers_every_raw_lap(any_session):
    a = clean.annotate_laps(any_session)
    raw = any_session.laps
    assert len(a) == len(raw)
    assert a.index.equals(raw.index)
    # Raw columns first and untouched, then the annotation block in the documented order.
    assert list(a.columns) == list(raw.columns) + ANNOTATION_COLUMNS
    for c in ANNOTATION_COLUMNS[1:]:
        assert a[c].dtype == bool, c
        assert not a[c].isna().any(), c


def test_annotate_laps_membership_matches_clean_laps(any_session):
    a = clean.annotate_laps(any_session)
    key = ["Driver", "LapNumber"]

    repr_keys = set(map(tuple, a.loc[a["is_representative"], key].itertuples(index=False)))
    clean_keys = set(map(tuple, clean.clean_laps(any_session)[key].itertuples(index=False)))
    assert repr_keys == clean_keys

    rule_keys = set(map(tuple, a.loc[a["is_clean"], key].itertuples(index=False)))
    no_outlier_keys = set(map(tuple, clean.clean_laps(any_session, drop_outliers=False)[key]
                              .itertuples(index=False)))
    assert rule_keys == no_outlier_keys

    # is_outlier is exactly the difference between the two filters, and never set on a
    # lap that failed a rule.
    assert (a["is_outlier"] & ~a["is_clean"]).sum() == 0
    assert (a["is_clean"] & ~a["is_representative"]).sum() == len(rule_keys) - len(repr_keys)
    assert (a["is_representative"] == (a["is_clean"] & ~a["is_outlier"])).all()
    assert (a["is_clean"] == ~a[[c for c in a.columns if c.startswith("excl_")]].any(axis=1)).all()
