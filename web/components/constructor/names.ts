// Display helpers for the constructor and "Was it the car?" surfaces. The mode2 tables
// key on `drivers.driver_id` and the §8.2 row types carry no display name, so an id is
// title-cased for display rather than invented: "max_verstappen" -> "Max Verstappen",
// "kevin_magnussen" -> "Kevin Magnussen", "norris" -> "Norris".
export function prettyDriver(driverId: string): string {
  return driverId
    .split("_")
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/** "aston_martin" -> "Aston Martin"; used only when session_teams has no name. */
export function prettyTeam(teamId: string): string {
  return prettyDriver(teamId);
}
