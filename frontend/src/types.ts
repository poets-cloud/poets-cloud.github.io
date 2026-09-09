export type WorkIndex = {
  id: string;
  title: string;
  authorId: number;
  authorName: string;
  dynasty: string;
  meter: string;
  excerpt: string;
  importance: number;
  bucket: string;
  position: [number, number, number];
};

export type WorkDetail = WorkIndex & {
  genre: string;
  rhythmic: string;
  lines: string[];
  tags: string[];
};

export type Manifest = {
  schemaVersion: number;
  datasetVersion: string;
  generatedAt: string;
  workCount: number;
  authorCount: number;
  dynastyCount: number;
  bucketCount: number;
};

export type Author = {
  id: number;
  name: string;
  dynasty: string;
  workCount: number;
  importance: number;
};

export type Dynasty = {
  id: number;
  name: string;
  workCount: number;
  authorCount: number;
};
