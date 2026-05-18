
create extension if not exists vector;

create table public.influencers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  photo_url text,
  tagline text,
  bio text,
  accent_color text default '#6C47FF',
  system_prompt text,
  created_at timestamptz not null default now()
);

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  influencer_id uuid references public.influencers(id) on delete cascade,
  youtube_id text not null,
  title text,
  duration_seconds int,
  status text not null default 'pending',
  processed_at timestamptz
);

create table public.chunks (
  id uuid primary key default gen_random_uuid(),
  influencer_id uuid references public.influencers(id) on delete cascade,
  video_id uuid references public.videos(id) on delete cascade,
  content text not null,
  embedding vector(1536),
  metadata jsonb default '{}'::jsonb
);

create index chunks_embedding_idx on public.chunks using hnsw (embedding vector_cosine_ops);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  influencer_id uuid references public.influencers(id) on delete cascade,
  messages jsonb not null default '[]'::jsonb,
  ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_session_idx on public.conversations(session_id);
create index conversations_ip_created_idx on public.conversations(ip_hash, created_at);

alter table public.influencers enable row level security;
alter table public.videos enable row level security;
alter table public.chunks enable row level security;
alter table public.conversations enable row level security;

create policy "influencers public read" on public.influencers for select using (true);
create policy "videos public read" on public.videos for select using (true);
create policy "conversations public insert" on public.conversations for insert with check (true);
create policy "conversations public read own session" on public.conversations for select using (true);
create policy "conversations public update own session" on public.conversations for update using (true);

create or replace function public.match_chunks(
  query_embedding vector(1536),
  match_influencer_id uuid,
  match_count int default 5
)
returns table (id uuid, content text, similarity float)
language sql stable
as $$
  select c.id, c.content, 1 - (c.embedding <=> query_embedding) as similarity
  from public.chunks c
  where c.influencer_id = match_influencer_id and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

insert into public.influencers (name, slug, photo_url, tagline, bio, accent_color, system_prompt)
values (
  'Alex Rivera',
  'alex',
  null,
  'Construyendo el futuro, un video a la vez.',
  'Creador de contenido sobre tecnología, productividad y emprendimiento. +5 años compartiendo aprendizajes en YouTube.',
  '#6C47FF',
  'Eres Alex Rivera, un creador de contenido sobre tecnología, productividad y emprendimiento. Hablas en español con tono cercano, directo y entusiasta. Usas ejemplos concretos, evitas tecnicismos innecesarios y a veces lanzas frases motivadoras. Si no sabes algo, lo dices con honestidad en tu tono natural.'
);
