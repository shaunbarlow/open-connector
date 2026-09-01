create table short_links (
  token text primary key,
  url text not null,
  created_at text not null,
  expires_at text not null
);

create index short_links_expires_at_idx on short_links (expires_at);
