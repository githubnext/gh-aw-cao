package githubquota

import "testing"

func TestClassifyBucketRejectionApp(t *testing.T) {
	bucket := BucketID{App: "Not Valid!", Installation: 1, Resource: ResourceCore}
	reason, rejected := classifyBucketRejection(bucket)
	if !rejected || reason != bucketRejectionReasonApp {
		t.Fatalf("classifyBucketRejection(%+v) = (%s, %t), want (%s, true)", bucket, reason, rejected, bucketRejectionReasonApp)
	}
}

func TestClassifyBucketRejectionInstallation(t *testing.T) {
	for _, installation := range []int64{0, -1} {
		bucket := BucketID{App: "collector", Installation: installation, Resource: ResourceCore}
		reason, rejected := classifyBucketRejection(bucket)
		if !rejected || reason != bucketRejectionReasonInstallation {
			t.Fatalf("classifyBucketRejection(%+v) = (%s, %t), want (%s, true)",
				bucket, reason, rejected, bucketRejectionReasonInstallation)
		}
	}
}

func TestClassifyBucketRejectionResource(t *testing.T) {
	bucket := BucketID{App: "collector", Installation: 1, Resource: "Not Valid!"}
	reason, rejected := classifyBucketRejection(bucket)
	if !rejected || reason != bucketRejectionReasonResource {
		t.Fatalf("classifyBucketRejection(%+v) = (%s, %t), want (%s, true)", bucket, reason, rejected, bucketRejectionReasonResource)
	}
}

func TestClassifyBucketRejectionAcceptsWellFormedBucket(t *testing.T) {
	bucket := BucketID{App: "collector", Installation: 1, Resource: ResourceCore}
	if reason, rejected := classifyBucketRejection(bucket); rejected {
		t.Fatalf("classifyBucketRejection(%+v) = (%s, true), want rejected=false", bucket, reason)
	}
}

func TestBucketIDValidate(t *testing.T) {
	tests := []struct {
		name    string
		bucket  BucketID
		wantErr bool
	}{
		{"well formed", BucketID{App: "collector", Installation: 1, Resource: ResourceCore}, false},
		{"empty app", BucketID{App: "", Installation: 1, Resource: ResourceCore}, true},
		{"non-positive installation", BucketID{App: "collector", Installation: 0, Resource: ResourceCore}, true},
		{"invalid resource", BucketID{App: "collector", Installation: 1, Resource: "Bad Resource"}, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.bucket.Validate()
			if (err != nil) != test.wantErr {
				t.Fatalf("Validate() error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

func TestNormalizeBucketLowercasesAndDefaultsResource(t *testing.T) {
	bucket, err := normalizeBucket(BucketID{App: " Collector ", Installation: 42})
	if err != nil {
		t.Fatalf("normalizeBucket returned error: %v", err)
	}
	want := BucketID{App: "collector", Installation: 42, Resource: ResourceCore}
	if bucket != want {
		t.Fatalf("normalizeBucket() = %+v, want %+v", bucket, want)
	}
}

func TestNormalizeBucketRejectsInvalidIdentity(t *testing.T) {
	if _, err := normalizeBucket(BucketID{App: "", Installation: 1}); err == nil {
		t.Fatal("normalizeBucket() error = nil, want an error for an empty app")
	}
}
