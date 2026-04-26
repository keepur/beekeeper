import type { Db, Collection } from "mongodb";
import type { AppliedFrameRecord } from "./types.js";

const COLLECTION = "applied_frames";

export class AppliedFramesStore {
  private readonly coll: Collection<AppliedFrameRecord>;

  constructor(db: Db) {
    this.coll = db.collection<AppliedFrameRecord>(COLLECTION);
  }

  async list(): Promise<AppliedFrameRecord[]> {
    return await this.coll.find({}).sort({ _id: 1 }).toArray();
  }

  async get(name: string): Promise<AppliedFrameRecord | null> {
    return await this.coll.findOne({ _id: name });
  }

  async upsert(record: AppliedFrameRecord): Promise<void> {
    await this.coll.replaceOne({ _id: record._id }, record, { upsert: true });
  }

  async remove(name: string): Promise<boolean> {
    const r = await this.coll.deleteOne({ _id: name });
    return r.deletedCount === 1;
  }

  /** Frames that declare a `requires` including the named frame. */
  async findDependents(name: string): Promise<string[]> {
    const docs = await this.coll
      .find({ "manifest.requires": name }, { projection: { _id: 1 } })
      .toArray();
    return docs.map((d) => d._id);
  }
}
