-- CreateIndex
CREATE INDEX "Comment_roomId_bookId_createdAt_id_idx" ON "Comment"("roomId", "bookId", "createdAt", "id");
