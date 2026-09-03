import { anonClient } from "../../lib/supabase";
import { publicUrlFor } from "../../lib/r2";
import { CatalogRef } from "../locations/locations.service";
import { SearchLocationsQuery } from "./search.schema";

interface SearchLocationRow {
  id: string;
  title: string;
  excerpt: string;
  city: string;
  region: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  capacity: number | null;
  distance_km: number | null;
  categories: CatalogRef[];
  use_cases: CatalogRef[];
  primary_media_key: string | null;
  created_at: string;
  total_count: number;
}

export interface SearchLocationCard {
  id: string;
  title: string;
  excerpt: string;
  city: string;
  region: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  capacity: number | null;
  categories: CatalogRef[];
  use_cases: CatalogRef[];
  primary_media_url: string | null;
  created_at: string;
  distance_km?: number;
}

export interface SearchResult {
  data: SearchLocationCard[];
  total: number;
}

function toCard(row: SearchLocationRow): SearchLocationCard {
  return {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    city: row.city,
    region: row.region,
    country: row.country,
    latitude: row.latitude,
    longitude: row.longitude,
    capacity: row.capacity,
    categories: row.categories,
    use_cases: row.use_cases,
    primary_media_url: row.primary_media_key ? publicUrlFor(row.primary_media_key) : null,
    created_at: row.created_at,
    ...(row.distance_km !== null ? { distance_km: row.distance_km } : {}),
  };
}

export async function searchLocations(query: SearchLocationsQuery): Promise<SearchResult> {
  const sort = query.sort ?? "relevant";

  const { data, error } = await anonClient.rpc("search_locations", {
    _search: query.search ?? null,
    _city: query.city ?? null,
    _region: query.region ?? null,
    _country: query.country ?? null,
    _category_ids: query.category_ids ?? null,
    _amenity_ids: query.amenity_ids ?? null,
    _use_case_ids: query.use_case_ids ?? null,
    _capacity_min: query.capacity_min ?? null,
    _capacity_max: query.capacity_max ?? null,
    _lat: query.lat ?? null,
    _lng: query.lng ?? null,
    _radius_km: query.radius_km ?? null,
    _north: query.north ?? null,
    _south: query.south ?? null,
    _east: query.east ?? null,
    _west: query.west ?? null,
    _sort: sort,
    _page: query.page,
    _page_size: query.pageSize,
  });

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as SearchLocationRow[];

  return {
    data: rows.map(toCard),
    total: rows.length > 0 ? rows[0]!.total_count : 0,
  };
}
