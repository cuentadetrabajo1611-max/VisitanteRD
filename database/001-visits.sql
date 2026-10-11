-- Run manually ONLY in a new dedicated application database, never the padrón.
-- No automatic migration or CREATE DATABASE/ATTACH/RESTORE is executed by the API.
SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF OBJECT_ID(N'dbo.Visits', N'U') IS NOT NULL
    THROW 50001, 'Visits already exists; inspect schema before proceeding.', 1;
CREATE TABLE dbo.Visits (
    id uniqueidentifier NOT NULL PRIMARY KEY,
    visitorLabel nvarchar(120) NOT NULL,
    destination nvarchar(120) NOT NULL,
    purpose nvarchar(240) NOT NULL,
    enteredAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    exitedAt datetime2(3) NULL,
    CONSTRAINT CK_Visits_Time CHECK (exitedAt IS NULL OR exitedAt >= enteredAt)
);
CREATE INDEX IX_Visits_Active ON dbo.Visits(enteredAt DESC) WHERE exitedAt IS NULL;
COMMIT TRANSACTION;
