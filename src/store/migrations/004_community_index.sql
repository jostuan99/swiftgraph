-- Lookups of the members and links of an area (get_community).
CREATE INDEX nodes_community ON nodes(community, pagerank);
