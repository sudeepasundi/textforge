Since your Notepad app supports table pasting, column alignment, advanced log reading, filtering, searching, and log analysis, I'll give you realistic dummy datasets rather than simple examples.

I've included different formats so you can test how your application handles real-world data.

### 1\. Dummy table datasets

Copy these tables directly into your app. Depending on the browser or editor, they may paste as tab-separated data.

### Table 1: Employee details

| Employee ID | Name          | Department  | Designation         | Salary | Location  | Status   |
| ----------- | ------------- | ----------- | ------------------- | ------ | --------- | -------- |
| EMP1001     | Rahul Sharma  | Engineering | Senior Developer    | 85000  | Bangalore | Active   |
| EMP1002     | Priya Nair    | QA          | Test Engineer       | 62000  | Chennai   | Active   |
| EMP1003     | Amit Verma    | DevOps      | Cloud Engineer      | 95000  | Hyderabad | Active   |
| EMP1004     | Sneha Rao     | Engineering | Tech Lead           | 120000 | Bangalore | Active   |
| EMP1005     | Karthik Kumar | Support     | Analyst             | 45000  | Chennai   | Inactive |
| EMP1006     | Divya Menon   | Engineering | Java Developer      | 78000  | Pune      | Active   |
| EMP1007     | Arjun Reddy   | QA          | Automation Engineer | 72000  | Hyderabad | Active   |
| EMP1008     | Meera Iyer    | DevOps      | SRE                 | 110000 | Bangalore | Active   |
| EMP1009     | Vikram Singh  | Security    | Security Analyst    | 88000  | Mumbai    | Inactive |
| EMP1010     | Ananya Das    | Engineering | Backend Developer   | 82000  | Kolkata   | Active   |

Test these features:

* Column selection and alignment.

* Sorting by salary.

* Searching for `Engineering`.

* Selecting individual columns.

* Copying selected rows.

* Handling long names and values.

### Table 2: API performance metrics

| API Endpoint       | Method | Requests | Avg Response (ms) | Max Response (ms) | Error Count | Status   |
| ------------------ | ------ | -------- | ----------------- | ----------------- | ----------- | -------- |
| /api/users         | GET    | 15200    | 120               | 450               | 12          | SUCCESS  |
| /api/orders        | POST   | 8700     | 350               | 1200              | 45          | WARNING  |
| /api/products      | GET    | 22000    | 95                | 300               | 0           | SUCCESS  |
| /api/payments      | POST   | 5400     | 850               | 3500              | 120         | CRITICAL |
| /api/auth/login    | POST   | 12500    | 180               | 800               | 8           | SUCCESS  |
| /api/reports       | GET    | 1200     | 2500              | 8000              | 32          | WARNING  |
| /api/notifications | POST   | 9800     | 210               | 950               | 5           | SUCCESS  |
| /api/inventory     | PUT    | 3400     | 450               | 1800              | 87          | WARNING  |
| /api/shipping      | GET    | 7600     | 160               | 600               | 3           | SUCCESS  |
| /api/refunds       | POST   | 950      | 1800              | 6500              | 110         | CRITICAL |

### Table 3: Database transaction records

| Transaction ID | User ID | Operation | Table Name | Execution Time (ms) | Rows Affected | Timestamp           |
| -------------- | ------- | --------- | ---------- | ------------------- | ------------- | ------------------- |
| TXN90001       | U1001   | INSERT    | employees  | 45                  | 1             | 2026-11-03 09:00:01 |
| TXN90002       | U1002   | UPDATE    | orders     | 120                 | 3             | 2026-11-03 09:00:05 |
| TXN90003       | U1003   | SELECT    | products   | 18                  | 25            | 2026-11-03 09:00:08 |
| TXN90004       | U1004   | DELETE    | sessions   | 250                 | 12            | 2026-11-03 09:00:11 |
| TXN90005       | U1001   | SELECT    | payments   | 1800                | 2             | 2026-11-03 09:00:15 |
| TXN90006       | U1005   | UPDATE    | employees  | 65                  | 1             | 2026-11-03 09:00:19 |
| TXN90007       | U1006   | INSERT    | audit_logs | 32                  | 1             | 2026-11-03 09:00:22 |
| TXN90008       | U1007   | SELECT    | orders     | 3200                | 500           | 2026-11-03 09:00:25 |

### Table 4: Messy data (stress test)

This one is deliberately designed to test alignment when values have different lengths.

| ID  | Name                      | Description                                  | Amount    | Date       | Remarks                      |
| --- | ------------------------- | -------------------------------------------- | --------- | ---------- | ---------------------------- |
| 1   | Raj                       | Payment                                      | 100       | 03-11-2026 | OK                           |
| 2   | Christopher               | International payment processing transaction | 150000.75 | 03-11-2026 | Pending approval             |
| 3   | A                         | Refund                                       | -2500     | 02-11-2026 | Rejected                     |
| 4   | Priyanka Sharma           | Subscription renewal                         | 999.99    | 01-11-2026 | Successfully completed       |
| 5   | Mohammed Abdul Rahman     | Bulk transaction reconciliation              | 2500000   | 31-10-2026 | Requires manual verification |
| 6   | Test                      | NULL                                         | 0         | NULL       | N/A                          |
| 7   | Long_User_Identifier_2026 | Account verification                         | 125.50    | 03-11-2026 | Duplicate entry detected     |

### 2\. Dummy log datasets

These are particularly useful for testing your advanced log-reading features.

### Log 1: Spring Boot application logs

Application log

Normal + Errors

```log
2026-11-03 09:00:01.120 INFO  [main] com.example.Application - Starting Application v2.5.0
2026-11-03 09:00:01.450 INFO  [main] com.example.Application - Active profiles: production
2026-11-03 09:00:02.100 INFO  [main] o.s.b.w.embedded.tomcat.TomcatWebServer - Tomcat started on port 8080
2026-11-03 09:00:02.300 INFO  [main] com.example.Application - Application started successfully in 2.45 seconds
2026-11-03 09:00:05.100 INFO  [http-nio-8080-exec-1] c.e.UserController - GET /api/users requested
2026-11-03 09:00:05.125 DEBUG [http-nio-8080-exec-1] c.e.UserService - Fetching user details for ID: 1001
2026-11-03 09:00:05.180 INFO  [http-nio-8080-exec-1] c.e.UserController - User retrieved successfully. ID: 1001
2026-11-03 09:00:08.250 WARN  [http-nio-8080-exec-2] c.e.PaymentService - Payment gateway response time exceeded 2000ms
2026-11-03 09:00:09.500 ERROR [http-nio-8080-exec-3] c.e.PaymentService - Payment processing failed for transaction TXN90045
2026-11-03 09:00:09.501 ERROR [http-nio-8080-exec-3] c.e.PaymentService - java.net.SocketTimeoutException: Read timed out
2026-11-03 09:00:09.502 ERROR [http-nio-8080-exec-3] c.e.PaymentService -     at com.example.gateway.PaymentGateway.process(PaymentGateway.java:145)
2026-11-03 09:00:09.503 ERROR [http-nio-8080-exec-3] c.e.PaymentService -     at com.example.service.PaymentService.execute(PaymentService.java:89)
2026-11-03 09:00:09.504 ERROR [http-nio-8080-exec-3] c.e.PaymentService -     at com.example.controller.PaymentController.pay(PaymentController.java:56)
2026-11-03 09:00:12.100 INFO  [http-nio-8080-exec-4] c.e.OrderService - Order ORD1001 created successfully
2026-11-03 09:00:15.200 WARN  [http-nio-8080-exec-5] c.e.DatabaseConfig - Database connection pool utilization at 85%
2026-11-03 09:00:18.400 INFO  [http-nio-8080-exec-6] c.e.AuthService - User authentication successful: USER1002
2026-11-03 09:00:21.600 ERROR [http-nio-8080-exec-7] c.e.UserService - User not found. ID: 99999
2026-11-03 09:00:25.800 INFO  [http-nio-8080-exec-8] c.e.Application - Health check completed successfully
```

Test:

* Color highlighting for INFO, DEBUG, WARN, ERROR.

* Filter only ERROR or WARN.

* Search for `TXN90045`.

* Search by thread name.

* Multiline stack trace grouping.

* Timestamp-based navigation.

### Log 2: Production server logs

This dataset contains several different types of failures.

```log
2026-11-03 10:15:01 INFO SERVER-01 CPU_USAGE=32% MEMORY_USAGE=58%
2026-11-03 10:15:02 INFO SERVER-01 ACTIVE_CONNECTIONS=125
2026-11-03 10:15:05 WARN SERVER-01 CPU_USAGE=82% THRESHOLD=80%
2026-11-03 10:15:08 ERROR SERVER-01 Disk space critically low: 95%
2026-11-03 10:15:10 WARN SERVER-02 MEMORY_USAGE=88%
2026-11-03 10:15:12 ERROR SERVER-02 Connection refused: database-primary:3306
2026-11-03 10:15:13 ERROR SERVER-02 Database health check failed
2026-11-03 10:15:15 INFO SERVER-01 Database connection restored
2026-11-03 10:15:18 WARN SERVER-03 Request latency exceeded threshold: 3500ms
2026-11-03 10:15:20 ERROR SERVER-03 HTTP 503 Service Unavailable
2026-11-03 10:15:22 INFO SERVER-03 Restart initiated
2026-11-03 10:15:30 INFO SERVER-03 Restart completed
2026-11-03 10:15:35 INFO SERVER-03 All health checks passed
2026-11-03 10:15:40 WARN SERVER-01 Disk space still above threshold: 91%
2026-11-03 10:15:45 ERROR SERVER-01 Failed to write temporary file
```

Test:

* Search across multiple server IDs.

* Search `ERROR` and `WARN` simultaneously.

* Highlight IPs, ports, percentages and numbers.

* Find repeated error patterns.

* Count occurrences of each severity.

### Log 3: Complex Java exception logs

Multiline stress test

```log
2026-11-03 11:20:01.100 INFO  Starting batch processing job JOB-1001
2026-11-03 11:20:01.200 INFO  Total records to process: 5000
2026-11-03 11:20:02.100 INFO  Processing record ID: 10001
2026-11-03 11:20:02.200 INFO  Processing record ID: 10002
2026-11-03 11:20:02.300 ERROR Failed to process record ID: 10003
java.lang.NullPointerException: Cannot invoke "String.length()" because "name" is null
    at com.example.batch.RecordProcessor.validate(RecordProcessor.java:45)
    at com.example.batch.RecordProcessor.process(RecordProcessor.java:78)
    at com.example.batch.BatchService.execute(BatchService.java:120)
    at com.example.batch.BatchJob.run(BatchJob.java:55)
Caused by: java.lang.IllegalArgumentException: Invalid input record
    at com.example.validation.InputValidator.validate(InputValidator.java:32)
    at com.example.batch.RecordProcessor.validate(RecordProcessor.java:40)

2026-11-03 11:20:03.100 INFO  Processing record ID: 10004
2026-11-03 11:20:03.200 WARN  Retry attempt 1 for record ID: 10005
2026-11-03 11:20:04.200 WARN  Retry attempt 2 for record ID: 10005
2026-11-03 11:20:05.200 ERROR Maximum retries exceeded for record ID: 10005
java.sql.SQLException: Connection is closed
    at com.mysql.cj.jdbc.ConnectionImpl.checkClosed(ConnectionImpl.java:1234)
    at com.mysql.cj.jdbc.ClientPreparedStatement.executeUpdate(ClientPreparedStatement.java:456)
    at com.example.repository.RecordRepository.save(RecordRepository.java:90)
    at com.example.batch.RecordProcessor.process(RecordProcessor.java:80)

2026-11-03 11:20:06.100 INFO  Processing record ID: 10006
2026-11-03 11:20:07.100 INFO  Batch processing completed
2026-11-03 11:20:07.200 INFO  Successful records: 4997
2026-11-03 11:20:07.300 INFO  Failed records: 3
```

Test:

* Stack trace folding and expansion.

* Exception grouping.

* Nested `Caused by` handling.

* Multiline selection and copying.

* Finding the first and last occurrence of exceptions.

### Log 4: Security and authentication logs

```log
2026-11-03 12:00:01 INFO AUTH User=admin IP=192.168.1.10 ACTION=LOGIN STATUS=SUCCESS
2026-11-03 12:00:05 INFO AUTH User=rahul IP=192.168.1.15 ACTION=LOGIN STATUS=SUCCESS
2026-11-03 12:00:10 WARN AUTH User=unknown IP=203.0.113.45 ACTION=LOGIN STATUS=FAILED
2026-11-03 12:00:11 WARN AUTH User=unknown IP=203.0.113.45 ACTION=LOGIN STATUS=FAILED
2026-11-03 12:00:12 WARN AUTH User=unknown IP=203.0.113.45 ACTION=LOGIN STATUS=FAILED
2026-11-03 12:00:13 ERROR AUTH User=unknown IP=203.0.113.45 ACTION=LOGIN STATUS=BLOCKED
2026-11-03 12:01:01 INFO AUTH User=admin ACTION=TOKEN_GENERATED TOKEN_ID=TKN1001
2026-11-03 12:01:05 INFO AUTH User=rahul ACTION=TOKEN_REFRESHED TOKEN_ID=TKN1002
2026-11-03 12:02:01 WARN AUTH User=admin ACTION=PASSWORD_CHANGE STATUS=FAILED
2026-11-03 12:02:10 INFO AUTH User=admin ACTION=PASSWORD_CHANGE STATUS=SUCCESS
2026-11-03 12:03:01 ERROR AUTH User=service-account ACTION=TOKEN_VALIDATION STATUS=EXPIRED
2026-11-03 12:03:05 INFO AUTH User=service-account ACTION=TOKEN_REFRESHED STATUS=SUCCESS
```

Test:

* IP address extraction.

* Unique IP counting.

* Failed login detection.

* Search for `203.0.113.45`.

* Repeated event detection.

* Filtering by user and action.

### 3\. Advanced stress-test datasets

These test edge cases that many text editors struggle with.

### Test A: Very long lines

```log
2026-11-03 13:00:01 INFO Request payload: {"userId":1001,"name":"Rahul Sharma","email":"rahul.sharma@example.com","address":"123 Main Street, Electronic City, Bangalore, Karnataka, India","preferences":{"language":"English","notifications":true,"theme":"dark"},"metadata":{"source":"mobile","version":"5.2.1","device":"Android","sessionId":"SESSION_123456789"}}
2026-11-03 13:00:02 ERROR Failed request: {"error":"VALIDATION_FAILED","message":"The supplied request contains invalid fields","details":{"field":"email","providedValue":"invalid-email-address","expectedFormat":"valid RFC-compliant email address","requestId":"REQ_20261103_123456789"}}
2026-11-03 13:00:03 INFO Successfully completed background synchronization operation for all registered users across the distributed application cluster.
```

Test horizontal scrolling, word wrapping, line numbers and copying complete lines.

### Test B: Special characters and Unicode

```text
INFO  Payment ₹1500.50 completed successfully
INFO  User name: José García
INFO  Message: こんにちは世界
INFO  Message: नमस्ते दुनिया
INFO  Special characters: !@#$%^&*()_+-=[]{}|;:',.<>/?
ERROR File path: C:\Users\admin\Desktop\logs\error.log
WARN  SQL: SELECT * FROM users WHERE name = 'John' AND status = 'ACTIVE';
INFO  JSON: {"key":"value","number":123,"boolean":true,"null":null}
```

Test encoding, search, regex and special-character handling.

### Test C: Duplicate and repetitive logs

```log
2026-11-03 14:00:01 ERROR Database connection timeout
2026-11-03 14:00:02 ERROR Database connection timeout
2026-11-03 14:00:03 ERROR Database connection timeout
2026-11-03 14:00:04 INFO Database connection restored
2026-11-03 14:00:05 ERROR Database connection timeout
2026-11-03 14:00:06 WARN Retry attempt 1
2026-11-03 14:00:07 WARN Retry attempt 2
2026-11-03 14:00:08 WARN Retry attempt 3
2026-11-03 14:00:09 ERROR Maximum retries exceeded
2026-11-03 14:00:10 INFO Service restarted
2026-11-03 14:00:11 INFO Service restarted
2026-11-03 14:00:12 INFO Service restarted
```

Test duplicate-line detection, occurrence count, grouping and deduplication.

### 4\. Feature validation checklist

Here is a checklist you can use while testing your Notepad application.

Testing progress

### 0/35

Table handling

Paste HTML tables from browsers

Paste tab-separated data

Paste comma-separated CSV data

Preserve empty cells

Handle multiline cell values

Column alignment and resizing

Column selection and copying

Very long cell values

Unicode and special characters

Log reading

INFO/WARN/ERROR/DEBUG highlighting

Search with case sensitivity

Regex search

Multiple keyword search

Filter by log severity

Find next / previous occurrence

Line numbers

Horizontal and vertical scrolling

Multiline stack trace grouping

Large file loading

Advanced analysis

Count ERROR/WARN/INFO occurrences

Find duplicate log entries

Extract timestamps

Extract IP addresses

Highlight UUIDs and transaction IDs

Filter by date and time

Compare two log sections

Copy filtered results

Preserve original line numbers

Editor stability

Undo and redo after paste

Handle 100,000+ lines

Handle 1 MB+ lines

Open multiple files

Save without changing encoding

Handle CRLF and LF line endings

Find and replace without freezing

Reset checklist

### 5\. My recommended performance benchmarks

If you want your app to feel like a serious developer tool, test these file sizes:

| Test       | Dataset size | Expected behavior                  |
| ---------- | ------------ | ---------------------------------- |
| Small      | 1 MB         | Instant opening                    |
| Medium     | 10 MB        | Smooth scrolling                   |
| Large      | 50 MB        | Responsive search                  |
| Very large | 100 MB       | No UI freezing                     |
| Extreme    | 500 MB       | Streaming or virtualized rendering |

For a developer-oriented Notepad app, I'd particularly prioritize large log files, regex search, multiline exception grouping, column editing, and preserving original formatting.

One important suggestion: don't just test whether the app displays 100 MB of logs. Test whether searching, selecting, copying and filtering remain responsive at that size.

I can also prepare a downloadable test-data pack containing separate `.txt`, `.log`, `.csv` and `.tsv` files, with a 100 MB synthetic log generator for performance testing.
