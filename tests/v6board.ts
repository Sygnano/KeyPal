/** The tests draw on the V6 8K ISO (the board the app was first built for): import this first. */
import V6 from "../src/data/boards/v6_8k_iso_encoder.json";
import type { BoardData } from "../src/lib/boards";
import { setBoard } from "../src/lib/layout";

setBoard(V6 as unknown as BoardData);
export const V6_BOARD = V6 as unknown as BoardData;
