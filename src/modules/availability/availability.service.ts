import { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError } from "../../errors/AppError";
import { getVisibleLocationOrNull } from "../locations/locations.service";
import { AvailabilityQuery } from "./availability.schema";

interface AvailabilityRow {
  date: string;
  start_at: string;
  end_at: string;
}

export interface DayAvailability {
  date: string;
  windows: { start: string; end: string }[];
}

export interface AvailabilityResult {
  days: DayAvailability[];
  timezone: string;
}

function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export async function getAvailability(
  supabase: SupabaseClient,
  locationId: string,
  query: AvailabilityQuery
): Promise<AvailabilityResult> {
  // Read visibility/existence through the same client the RPC will use — a
  // location invisible to this caller is just 404, same idiom as the
  // location detail endpoint (no owner-vs-public distinction on a read).
  const location = await getVisibleLocationOrNull(supabase, locationId);
  if (!location) {
    throw new NotFoundError("Location not found.");
  }

  const { data, error } = await supabase.rpc("get_location_availability", {
    _location_id: locationId,
    _from_date: query.from,
    _to_date: query.to,
  });

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as AvailabilityRow[];
  const byDate = new Map<string, { start: string; end: string }[]>();
  for (const row of rows) {
    const windows = byDate.get(row.date) ?? [];
    windows.push({ start: row.start_at, end: row.end_at });
    byDate.set(row.date, windows);
  }

  const days: DayAvailability[] = eachDate(query.from, query.to).map((date) => ({
    date,
    windows: byDate.get(date) ?? [],
  }));

  return { days, timezone: location.timezone };
}
